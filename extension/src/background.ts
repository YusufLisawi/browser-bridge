/**
 * Background service worker = orchestrator.
 *
 * - Ensures the offscreen document (which holds the WebSocket) is alive.
 * - Receives Jobs relayed from offscreen, drives the LinkedIn tab by URL
 *   navigation (so SPA teardown never strands a job), and issues granular
 *   scrape commands to the stateless content script.
 *
 * No DOM/window here — only chrome.* APIs.
 */

import type {
  Job,
  JobResult,
  PageContent,
  ProfileData,
  SearchHit,
  StoredAutomation,
} from "../../shared/protocol"
import type { ContentCommand } from "./content"
import { runRecipeInExtension, type RecipeLike } from "./auto-runner"
import {
  clearStoredAutomations,
  deleteStoredAutomation,
  getAutoRun,
  getStoredAutomation,
  listStoredAutomations,
  requestAutoCancel,
  setAutoRun,
  upsertStoredAutomation,
} from "./auto-store"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* ----------------------------- offscreen -------------------------------- */

let creating: Promise<void> | null = null

async function ensureOffscreen(): Promise<void> {
  if (creating) return creating
  creating = (async () => {
    try {
      if (await chrome.offscreen.hasDocument()) return
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        // String literal (not the enum object) in case the runtime enum is absent.
        reasons: ["WORKERS" as chrome.offscreen.Reason],
        justification: "Maintain a WebSocket connection to the local CLI server.",
      })
      await chrome.storage.local.set({ offscreenError: null, offscreenReadyAt: Date.now() })
      console.debug("[bridge] offscreen document created")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error("[bridge] offscreen creation failed:", message)
      await chrome.storage.local.set({ offscreenError: message })
    }
  })()
  try {
    await creating
  } finally {
    creating = null
  }
}

chrome.runtime.onStartup.addListener(() => void ensureOffscreen())
chrome.runtime.onInstalled.addListener(() => {
  void ensureOffscreen()
  chrome.alarms.create("keep-offscreen", { periodInMinutes: 0.5 })
})
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keep-offscreen") void ensureOffscreen()
})
void ensureOffscreen()

/* ------------------------------ tab helpers ----------------------------- */

const LINKEDIN_FEED = "https://www.linkedin.com/feed/"

async function getLinkedInTab(): Promise<number> {
  const tabs = await chrome.tabs.query({ url: ["*://*.linkedin.com/*"] })
  if (tabs.length) {
    const active = tabs.find((t) => t.active) ?? tabs[0]
    if (active.id != null) return active.id
  }
  const created = await chrome.tabs.create({ url: LINKEDIN_FEED, active: false })
  if (created.id == null) throw new Error("Could not open a LinkedIn tab")
  await waitForComplete(created.id, "linkedin.com", 30000)
  return created.id
}

function waitForComplete(tabId: number, expectInUrl: string, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeout)
    const listener = (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (id === tabId && info.status === "complete" && tab.url?.includes(expectInUrl)) finish(true)
    }
    function finish(v: boolean) {
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve(v)
    }
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete" && tab.url?.includes(expectInUrl)) finish(true)
    })
  })
}

/** Send a command to the content script, retrying while it boots after a load. */
async function sendCmd<T = unknown>(tabId: number, cmd: ContentCommand, retries = 10): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < retries; i += 1) {
    try {
      return (await chrome.tabs.sendMessage(tabId, cmd)) as T
    } catch (err) {
      lastErr = err
      await sleep(700)
    }
  }
  throw new Error(`content script not responding: ${String(lastErr)}`)
}

/** Navigate the tab by URL and wait until the target page is interactive. */
async function navigate(tabId: number, url: string, expectInUrl: string, anchor: string): Promise<void> {
  await chrome.tabs.update(tabId, { url })
  await waitForComplete(tabId, expectInUrl, 30000)
  const res = await sendCmd<{ found: boolean }>(tabId, { cmd: "waitAnchor", selector: anchor, timeout: 12000 })
  if (!res?.found) throw new Error(`page anchor not found (${anchor}) at ${url}`)
}

/* ------------------------- generic page reading ------------------------- */

/** A reusable background tab for generic reads, so we don't clobber active tabs. */
async function getBridgeTab(): Promise<number> {
  const { bridgeTabId } = await chrome.storage.local.get("bridgeTabId")
  if (typeof bridgeTabId === "number") {
    try {
      const tab = await chrome.tabs.get(bridgeTabId)
      if (tab?.id != null) return tab.id
    } catch {
      /* tab was closed — make a new one */
    }
  }
  const created = await chrome.tabs.create({ url: "about:blank", active: false })
  if (created.id == null) throw new Error("Could not open a bridge tab")
  await chrome.storage.local.set({ bridgeTabId: created.id })
  return created.id
}

/**
 * Runs IN the page (via executeScript). Self-contained — no outer references.
 * Scrolls to trigger lazy content, strips chrome, resolves URLs to absolute,
 * returns readable HTML + the page's links.
 */
async function extractReadable(): Promise<PageContent> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  // Nudge lazy content in.
  for (let y = 0; y < 4000; y += 800) {
    window.scrollBy(0, 800)
    await sleep(120)
  }
  window.scrollTo(0, 0)

  const abs = (u: string | null): string => {
    try {
      return new URL(u ?? "", location.href).href
    } catch {
      return u ?? ""
    }
  }

  // Contact signals from the WHOLE page (before we strip footers/etc.).
  const emails = new Set<string>()
  const phones = new Set<string>()
  const socials = new Set<string>()
  document.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
    const e = (a.getAttribute("href") ?? "").slice(7).split("?")[0].trim()
    if (e) emails.add(e)
  })
  document.querySelectorAll('a[href^="tel:"]').forEach((a) => {
    const t = (a.getAttribute("href") ?? "").slice(4).trim()
    if (t) phones.add(t)
  })
  const bodyText = (document.body as HTMLElement).innerText ?? ""
  ;(bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? []).forEach((e) =>
    emails.add(e)
  )
  ;(bodyText.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g) ?? []).forEach((p) =>
    phones.add(p.trim())
  )
  document.querySelectorAll("a[href]").forEach((a) => {
    const h = (a as HTMLAnchorElement).href
    if (/(linkedin|instagram|facebook|twitter|x|youtube|tiktok)\.com/i.test(h)) socials.add(h)
  })
  const contacts = {
    emails: [...emails].slice(0, 25),
    phones: [...phones].slice(0, 25),
    socials: [...socials].slice(0, 25),
  }

  const links: { href: string; text: string }[] = []
  const seen = new Set<string>()
  document.querySelectorAll("a[href]").forEach((a) => {
    const href = abs(a.getAttribute("href"))
    if (!/^https?:/i.test(href) || seen.has(href)) return
    seen.add(href)
    const text = (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
    links.push({ href, text })
  })

  const main =
    document.querySelector("main") ??
    document.querySelector("article") ??
    document.querySelector('[role="main"]') ??
    document.body
  const clone = main.cloneNode(true) as HTMLElement
  clone
    .querySelectorAll("script, style, noscript, svg, nav, header, footer, aside, form, iframe, button")
    .forEach((el) => el.remove())
  clone.querySelectorAll("a[href]").forEach((a) => a.setAttribute("href", abs(a.getAttribute("href"))))
  // Drop data:/blob: and empty images (base64 thumbnails bloat the output);
  // keep real http(s) images with absolute src.
  clone.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? ""
    if (!src || src.startsWith("data:") || src.startsWith("blob:")) {
      img.remove()
      return
    }
    img.setAttribute("src", abs(src))
  })

  return { url: location.href, title: document.title, html: clone.innerHTML, links, contacts }
}

async function runRead(url?: string, tab?: string): Promise<PageContent> {
  const tabId = url ? await getBridgeTab() : await resolveTab(tab)
  if (url) {
    let host = ""
    try {
      host = new URL(url).hostname
    } catch {
      throw new Error(`Invalid URL: ${url}`)
    }
    await chrome.tabs.update(tabId, { url })
    await waitForComplete(tabId, host, 30000)
    await sleep(800)
  }
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractReadable,
  })
  if (!injection?.result) throw new Error(`Could not read page${url ? `: ${url}` : ""}`)
  return injection.result as PageContent
}

/* --------------------------- browser actions ---------------------------- */

/**
 * Runs IN the page (via executeScript). Self-contained. Handles both:
 *   { op: "snapshot" }        → interactive elements (refs tagged via data-bb-ref)
 *   { op: "act", step: {...} } → perform one action, return a StepResult
 */
async function bbExec(payload: any): Promise<any> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const isVisible = (el: any) => {
    if (!(el instanceof Element)) return false
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"
  }
  const accName = (el: any): string => {
    const aria = el.getAttribute("aria-label")
    if (aria) return aria.trim()
    const lb = el.getAttribute("aria-labelledby")
    if (lb) {
      const l = document.getElementById(lb)
      if (l) return (l.textContent || "").replace(/\s+/g, " ").trim()
    }
    if (el.id) {
      const lab = document.querySelector(`label[for="${(window as any).CSS.escape(el.id)}"]`)
      if (lab) return (lab.textContent || "").replace(/\s+/g, " ").trim()
    }
    const ph = el.getAttribute("placeholder")
    if (ph) return ph.trim()
    const title = el.getAttribute("title")
    if (title) return title.trim()
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim()
    if (txt && txt.length <= 80) return txt
    return el.getAttribute("value") || ""
  }
  const SEL =
    'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="combobox"],[role="textbox"],[role="switch"],[role="tab"],[role="menuitem"],[contenteditable=""],[contenteditable="true"]'
  const collect = (root: any, out: any[]) => {
    try {
      root.querySelectorAll(SEL).forEach((n: any) => out.push(n))
    } catch {}
    try {
      root.querySelectorAll("*").forEach((n: any) => {
        if (n.shadowRoot) collect(n.shadowRoot, out)
      })
    } catch {}
  }
  const snapshot = () => {
    const raw: any[] = []
    collect(document, raw)
    const seen = new Set<any>()
    const elements: any[] = []
    let i = 1
    for (const el of raw) {
      if (seen.has(el) || !isVisible(el)) continue
      seen.add(el)
      const ref = "e" + i++
      el.setAttribute("data-bb-ref", ref)
      const tag = el.tagName.toLowerCase()
      const node: any = { ref, tag }
      const type = el.getAttribute("type")
      if (type) node.type = type
      const role = el.getAttribute("role")
      if (role) node.role = role
      const name = accName(el)
      if (name) node.name = name.slice(0, 100)
      if ("value" in el && el.value) node.value = String(el.value).slice(0, 100)
      const ph = el.getAttribute("placeholder")
      if (ph) node.placeholder = ph
      if (tag === "input" && (type === "checkbox" || type === "radio")) node.checked = el.checked
      if (tag === "select") node.options = Array.from(el.options).map((o: any) => o.value).slice(0, 40)
      if (tag === "a") node.href = el.href
      if (el.disabled) node.disabled = true
      elements.push(node)
      if (elements.length >= 200) break
    }
    return { url: location.href, title: document.title, elements }
  }
  const deepFind = (pred: (r: any) => any, root: any = document): any => {
    const direct = pred(root)
    if (direct) return direct
    const els = root.querySelectorAll("*")
    for (const n of els) {
      if (n.shadowRoot) {
        const f = deepFind(pred, n.shadowRoot)
        if (f) return f
      }
    }
    return null
  }
  const resolve = (target?: string): any => {
    if (!target) return null
    if (/^e\d+$/.test(target)) return deepFind((r) => r.querySelector(`[data-bb-ref="${target}"]`))
    try {
      const el = deepFind((r) => r.querySelector(target))
      if (el) return el
    } catch {}
    try {
      const xp = document.evaluate(target, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
      if (xp.singleNodeValue) return xp.singleNodeValue
    } catch {}
    return null
  }
  const setNativeValue = (el: any, value: string) => {
    const proto =
      el.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
    if (setter) setter.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
  }

  if (payload.op === "snapshot") return snapshot()

  // --- human-like motion helpers (synthetic events; isTrusted is still false) ---
  const rand = (a: number, b: number) => a + Math.random() * (b - a)
  const w: any = window
  const mouse = (w.__bbMouse = w.__bbMouse || { x: innerWidth / 2, y: innerHeight / 2 })
  const fireMouse = (type: string, x: number, y: number, el?: any) => {
    const target = el || document.elementFromPoint(x, y) || document.body
    target.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window })
    )
  }
  const humanMoveTo = async (x: number, y: number, steps?: number) => {
    const n = Math.max(2, steps ?? Math.round(rand(6, 14)))
    const sx = mouse.x
    const sy = mouse.y
    for (let i = 1; i <= n; i += 1) {
      const p = i / n
      // ease-in-out + small lateral wobble
      const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2
      const jx = i < n ? rand(-3, 3) : 0
      const jy = i < n ? rand(-3, 3) : 0
      const cx = sx + (x - sx) * e + jx
      const cy = sy + (y - sy) * e + jy
      mouse.x = cx
      mouse.y = cy
      fireMouse("mousemove", cx, cy)
      await sleep(rand(8, 28))
    }
    mouse.x = x
    mouse.y = y
  }
  const pointFor = (el: any) => {
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width * rand(0.3, 0.7), y: r.top + r.height * rand(0.3, 0.7) }
  }
  const humanScroll = async (dir: "down" | "up", total?: number) => {
    const atBottom = () => innerHeight + window.scrollY >= document.body.scrollHeight - 4
    const atTop = () => window.scrollY <= 2
    let moved = 0
    for (let i = 0; i < 100; i += 1) {
      if (dir === "down" && (atBottom() || (total != null && moved >= total))) break
      if (dir === "up" && (atTop() || (total != null && moved >= total))) break
      const stepPx = rand(220, 560)
      const dy = dir === "down" ? stepPx : -stepPx
      window.scrollBy({ top: dy })
      moved += stepPx
      await sleep(rand(140, 420))
      // occasional human "re-read" jitter back the other way
      if (Math.random() < 0.15) {
        window.scrollBy({ top: dir === "down" ? -rand(40, 120) : rand(40, 120) })
        await sleep(rand(120, 300))
      }
    }
  }

  const step = payload.step
  const a = step.action
  const res: any = { action: a, target: step.target, ok: false }
  try {
    if (a === "waitFor") {
      const start = Date.now()
      const timeout = step.timeout ?? 10000
      while (Date.now() - start < timeout) {
        if (resolve(step.target)) return { ...res, ok: true }
        await sleep(250)
      }
      return { ...res, error: "timeout waiting for " + step.target }
    }
    if (a === "waitForUrl") {
      const start = Date.now()
      const timeout = step.timeout ?? 15000
      const needle = step.target ?? ""
      while (Date.now() - start < timeout) {
        if (location.href.includes(needle)) return { ...res, ok: true, value: location.href }
        await sleep(250)
      }
      return { ...res, error: "timeout waiting for url ~ " + needle + " (now " + location.href + ")" }
    }
    if (a === "scroll") {
      if (step.human) {
        if (step.target === "top") await humanScroll("up")
        else if (step.target === "bottom") await humanScroll("down")
        else await humanScroll((step.deltaY ?? 0) < 0 ? "up" : "down", Math.abs(step.deltaY ?? innerHeight))
      } else {
        if (step.target === "top") window.scrollTo({ top: 0 })
        else if (step.target === "bottom") window.scrollTo({ top: document.body.scrollHeight })
        else window.scrollBy({ top: step.deltaY ?? window.innerHeight })
        await sleep(150)
      }
      return { ...res, ok: true, value: String(Math.round(window.scrollY)) }
    }
    if (a === "mouseMove") {
      let x = step.x
      let y = step.y
      if ((x == null || y == null) && step.target) {
        const t = resolve(step.target)
        if (!t) return { ...res, error: "element not found: " + step.target }
        if (t.scrollIntoView) t.scrollIntoView({ block: "center" })
        const p = pointFor(t)
        x = p.x
        y = p.y
      }
      if (x == null || y == null) return { ...res, error: "mouseMove needs target or x/y" }
      await humanMoveTo(x, y, step.steps)
      return { ...res, ok: true, value: `${Math.round(x)},${Math.round(y)}` }
    }
    const el = resolve(step.target)
    if (!el && a !== "press") return { ...res, error: "element not found: " + step.target }
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" })
    switch (a) {
      case "click": {
        if (step.human) {
          const p = pointFor(el)
          await humanMoveTo(p.x, p.y, step.steps)
          await sleep(rand(40, 160))
          fireMouse("mouseover", p.x, p.y, el)
          el.focus?.()
          fireMouse("mousedown", p.x, p.y, el)
          await sleep(rand(30, 90))
          fireMouse("mouseup", p.x, p.y, el)
          el.click()
        } else {
          el.focus?.()
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
          el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
          el.click()
        }
        break
      }
      case "fill":
      case "type":
      case "setValue":
        el.focus?.()
        setNativeValue(el, step.text ?? step.value ?? "")
        break
      case "select": {
        const v = step.value ?? step.text ?? ""
        const opt = Array.from(el.options || []).find(
          (o: any) => o.value === v || (o.textContent || "").trim() === v
        ) as any
        el.value = opt ? opt.value : v
        el.dispatchEvent(new Event("input", { bubbles: true }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
        break
      }
      case "check":
      case "uncheck":
        el.checked = a === "check"
        el.dispatchEvent(new Event("input", { bubbles: true }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
        break
      case "press": {
        const t = el || document.activeElement || document.body
        const key = step.key || "Enter"
        ;["keydown", "keypress", "keyup"].forEach((tp) =>
          t.dispatchEvent(new KeyboardEvent(tp, { key, bubbles: true }))
        )
        if (key === "Enter" && t.form) t.form.requestSubmit?.()
        break
      }
      case "hover":
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }))
        break
      case "focus":
        el.focus?.()
        break
      case "scrollIntoView":
        break // already scrolled above
      case "submit": {
        const f = el.tagName === "FORM" ? el : el.closest("form")
        if (f) (f.requestSubmit ? f.requestSubmit() : f.submit())
        else return { ...res, error: "no form for " + step.target }
        break
      }
      case "getText":
        return { ...res, ok: true, value: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 2000) }
      case "getValue":
        return { ...res, ok: true, value: el.value ?? "" }
      default:
        return { ...res, error: "unknown action: " + a }
    }
    return { ...res, ok: true }
  } catch (e: any) {
    return { ...res, error: String((e && e.message) || e) }
  }
}

/**
 * Runs IN the page (MAIN world, via executeScript). Self-contained.
 * Compiles `code` as the body of an async function (so `await` and `return`
 * both work), races it against a timeout, and returns a JSON-safe value.
 * `arg` is exposed to the code as `arg`.
 *
 * NOTE: the `new Function` here is the one piece governed by the PAGE's CSP
 * (script-src 'unsafe-eval'); on the rare strict-CSP page that forbids it the
 * call throws an EvalError, which we surface cleanly.
 */
async function bbEval(payload: { code: string; arg?: unknown; timeout?: number }): Promise<any> {
  const timeoutMs = payload.timeout ?? 15000
  const safe = (v: any) => {
    try {
      return JSON.parse(JSON.stringify(v === undefined ? null : v))
    } catch {
      try {
        return String(v)
      } catch {
        return null
      }
    }
  }
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      "arg",
      '"use strict";\nreturn (async () => {\n' + payload.code + "\n})();"
    )
    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error("eval timed out after " + timeoutMs + "ms")), timeoutMs)
    )
    const value = await Promise.race([Promise.resolve(fn(payload.arg)), timeout])
    return { ok: true, value: safe(value) }
  } catch (e: any) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

async function runEval(
  code: string,
  arg: unknown,
  timeout: number | undefined,
  target?: string
): Promise<{ url: string; value: unknown }> {
  const tabId = await resolveTab(target)
  const [inj] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: bbEval,
    args: [{ code, arg, timeout }],
  })
  const r = (inj?.result ?? { ok: false, error: "no result" }) as {
    ok: boolean
    value?: unknown
    error?: string
  }
  if (!r.ok) throw new Error(r.error ?? "eval failed")
  const url = (await chrome.tabs.get(tabId)).url ?? ""
  return { url, value: r.value }
}

async function resolveTab(target?: string): Promise<number> {
  if (target && /^\d+$/.test(target)) {
    const tab = await chrome.tabs.get(Number(target))
    if (tab?.id != null) return tab.id
  }
  if (target === "active") {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab?.id != null) return tab.id
  }
  return getBridgeTab()
}

async function listTabs() {
  const tabs = await chrome.tabs.query({})
  return tabs
    .filter((t) => t.id != null)
    .map((t) => ({
      id: t.id as number,
      active: !!t.active,
      title: (t.title ?? "").slice(0, 120),
      url: t.url ?? "",
      windowId: t.windowId,
    }))
}

async function runTabs(op: string, tabId?: number, url?: string) {
  if (op === "activate" && tabId != null) {
    const t = await chrome.tabs.update(tabId, { active: true })
    if (t?.windowId != null) await chrome.windows.update(t.windowId, { focused: true })
  } else if (op === "close" && tabId != null) {
    await chrome.tabs.remove(tabId)
  } else if (op === "new") {
    await chrome.tabs.create({ url: url || "about:blank", active: true })
  }
  return listTabs()
}

/** Capture the visible area of a tab as a PNG data URL (Tier 1, no debugger).
 *  Briefly activates the target tab, captures, then restores the prior tab. */
async function runScreenshot(target?: string): Promise<string> {
  const tabId = await resolveTab(target)
  const tab = await chrome.tabs.get(tabId)
  const windowId = tab.windowId
  const [prevActive] = await chrome.tabs.query({ active: true, windowId })
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true })
    await sleep(200)
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" })
  if (prevActive?.id != null && prevActive.id !== tabId) {
    await chrome.tabs.update(prevActive.id, { active: true })
  }
  return dataUrl
}

async function runSnapshot(target?: string) {
  const tabId = await resolveTab(target)
  const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: bbExec, args: [{ op: "snapshot" }] })
  return inj.result as { url: string; title: string; elements: unknown[] }
}

async function runActions(actions: any[], target?: string, withSnapshot = true, continueOnError = false) {
  const tabId = await resolveTab(target)
  const results: any[] = []
  for (const step of actions) {
    let result: any
    if (step.action === "navigate") {
      let host = ""
      try {
        host = new URL(step.url).hostname
      } catch {}
      await chrome.tabs.update(tabId, { url: step.url })
      await waitForComplete(tabId, host, 30000)
      await sleep(600)
      result = { action: "navigate", target: step.url, ok: true }
    } else if (step.action === "eval") {
      // Arbitrary JS, MAIN world — same engine as the standalone eval job.
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: bbEval,
        args: [{ code: step.code ?? "", arg: step.arg, timeout: step.timeout }],
      })
      const r = (inj?.result ?? { ok: false, error: "no result" }) as any
      result = { action: "eval", target: step.as, ok: !!r.ok, json: r.value, error: r.error }
    } else {
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId },
        func: bbExec,
        args: [{ op: "act", step }],
      })
      result = inj.result
      // getText/getValue return a string `value`; also expose it as json for parsing.
      if (result && result.value != null && result.json == null) result.json = result.value
    }
    results.push(result)
    if (!continueOnError && result && result.ok === false) break // fail-fast
    await sleep(250) // small pacing between actions
  }
  const out: any = { url: (await chrome.tabs.get(tabId)).url, results }
  if (withSnapshot) {
    const [snap] = await chrome.scripting.executeScript({ target: { tabId }, func: bbExec, args: [{ op: "snapshot" }] })
    out.snapshot = (snap.result as any).elements
  }
  return out
}

/* ------------------------------ URL helpers ----------------------------- */

function peopleSearchUrl(keyword: string, page = 1): string {
  const url = new URL("https://www.linkedin.com/search/results/people/")
  url.searchParams.set("keywords", keyword)
  if (page > 1) url.searchParams.set("page", String(page))
  return url.toString()
}

/** Resolve a target (url | slug | name) into a profile URL, searching if needed. */
async function resolveProfileUrl(tabId: number, target: string): Promise<string> {
  const t = target.trim()
  const inMatch = t.match(/\/in\/([^/?#]+)/)
  if (inMatch) return `https://www.linkedin.com/in/${inMatch[1]}/`
  if (!/\s/.test(t) && !/^https?:/i.test(t)) return `https://www.linkedin.com/in/${encodeURIComponent(t)}/`

  // Treat as a name → search and take the first hit.
  const hits = await runSearch(tabId, t, 1)
  const first = hits.find((h) => h.profileUrl)
  if (!first?.profileUrl) throw new Error(`No profile found for "${target}"`)
  return first.profileUrl
}

/* ----------------------------- job runners ------------------------------ */

async function runSearch(tabId: number, query: string, pages: number): Promise<SearchHit[]> {
  const all: SearchHit[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= pages; page += 1) {
    await navigate(
      tabId,
      peopleSearchUrl(query, page),
      "/search/results/people",
      '[role="list"], [data-view-name="people-search-result"]'
    )
    const { hits } = await sendCmd<{ hits: SearchHit[] }>(tabId, { cmd: "scrapeSearch" })
    for (const hit of hits) {
      const key = hit.profileUrl ?? hit.name ?? ""
      if (key && !seen.has(key)) {
        seen.add(key)
        all.push(hit)
      }
    }
    if (page < pages) await sleep(2000 + Math.random() * 2000)
  }
  return all
}

const PROFILE_ANCHOR = 'section[aria-label="Primary content"]'

/** Single page load: scrape the top card + latest post from the first profile page. */
async function runProfile(tabId: number, target: string): Promise<ProfileData> {
  const profileUrl = await resolveProfileUrl(tabId, target)
  const slug = profileUrl.match(/\/in\/([^/?#]+)/)?.[1] ?? ""
  await navigate(tabId, profileUrl, `/in/${slug}`, PROFILE_ANCHOR)
  const { profile } = await sendCmd<{ profile: ProfileData }>(tabId, { cmd: "scrapeProfileMain" })
  return profile
}

/* --------------------------- capture (non-CDP) -------------------------- */

const CAPTURE_ID = "bb-capture"

/** Runs IN the page (MAIN world) — reads (and optionally clears) the buffer. */
function bbReadCapture(payload: { kind: string; clear: boolean }): any {
  const cap = (window as any).__bbCapture
  if (!cap) return { present: false, items: [] }
  const items = (payload.kind === "logs" ? cap.logs : cap.network).slice()
  if (payload.clear) {
    if (payload.kind === "logs") cap.logs.length = 0
    else cap.network.length = 0
  }
  return { present: true, items }
}

async function isMonitorActive(): Promise<boolean> {
  try {
    const regs = await chrome.scripting.getRegisteredContentScripts({ ids: [CAPTURE_ID] })
    return regs.length > 0
  } catch {
    return false
  }
}

/** Arm capture: register the MAIN-world hook for future loads + inject into
 *  every currently-open http(s) tab so it works without a manual reload. */
async function runMonitor(op: "start" | "stop" | "status"): Promise<boolean> {
  if (op === "status") return isMonitorActive()
  if (op === "stop") {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [CAPTURE_ID] })
    } catch {
      /* not registered */
    }
    await chrome.storage.local.set({ monitorActive: false })
    return false
  }
  // start — re-register cleanly
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CAPTURE_ID] })
  } catch {
    /* fine */
  }
  await chrome.scripting.registerContentScripts([
    {
      id: CAPTURE_ID,
      matches: ["http://*/*", "https://*/*"],
      js: ["capture.js"],
      runAt: "document_start",
      world: "MAIN" as chrome.scripting.ExecutionWorld,
      allFrames: false,
      persistAcrossSessions: false,
    },
  ])
  // Best-effort: install into already-open tabs (catches future events there).
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })
  await Promise.all(
    tabs.map((t) =>
      t.id != null
        ? chrome.scripting
            .executeScript({ target: { tabId: t.id }, world: "MAIN", files: ["capture.js"] })
            .catch(() => {})
        : Promise.resolve()
    )
  )
  await chrome.storage.local.set({ monitorActive: true })
  return true
}

async function runCapture(
  kind: "logs" | "network",
  target?: string,
  clear = false
): Promise<{ url: string; items: unknown[] }> {
  const tabId = await resolveTab(target)
  const [inj] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: bbReadCapture,
    args: [{ kind, clear }],
  })
  const r = (inj?.result ?? { present: false, items: [] }) as { present: boolean; items: unknown[] }
  const url = (await chrome.tabs.get(tabId)).url ?? ""
  if (!r.present) {
    throw new Error(
      "No capture buffer on this tab. Run `bridge monitor start`, then reload the page (or navigate) to capture from load."
    )
  }
  return { url, items: r.items }
}

async function runJob(job: Job): Promise<JobResult> {
  if (job.kind === "ping") return { id: job.id, ok: true, kind: "ping" }
  if (job.kind === "read") {
    const page = await runRead(job.url, job.tab)
    return { id: job.id, ok: true, kind: "read", page }
  }
  if (job.kind === "tabs") {
    const tabs = await runTabs(job.op, job.tabId, job.url)
    return { id: job.id, ok: true, kind: "tabs", tabs }
  }
  if (job.kind === "screenshot") {
    const dataUrl = await runScreenshot(job.tab)
    return { id: job.id, ok: true, kind: "screenshot", dataUrl }
  }
  if (job.kind === "snapshot") {
    const s = await runSnapshot(job.tab)
    return { id: job.id, ok: true, kind: "snapshot", url: s.url, title: s.title, elements: s.elements as never }
  }
  if (job.kind === "act") {
    const r = await runActions(job.actions, job.tab, job.snapshot !== false, job.continueOnError === true)
    return { id: job.id, ok: true, kind: "act", url: r.url, results: r.results as never, snapshot: r.snapshot }
  }
  if (job.kind === "eval") {
    const r = await runEval(job.code, job.arg, job.timeout, job.tab)
    return { id: job.id, ok: true, kind: "eval", url: r.url, value: r.value }
  }
  if (job.kind === "monitor") {
    const active = await runMonitor(job.op)
    return { id: job.id, ok: true, kind: "monitor", active }
  }
  if (job.kind === "logs") {
    const r = await runCapture("logs", job.tab, job.clear === true)
    return { id: job.id, ok: true, kind: "logs", url: r.url, logs: r.items as never }
  }
  if (job.kind === "network") {
    const r = await runCapture("network", job.tab, job.clear === true)
    return { id: job.id, ok: true, kind: "network", url: r.url, requests: r.items as never }
  }
  if (job.kind === "automations") {
    if (job.op === "upsert") {
      if (!job.automation) throw new Error("automations upsert requires automation payload")
      const list = await upsertStoredAutomation(job.automation)
      return { id: job.id, ok: true, kind: "automations", automations: list }
    }
    if (job.op === "delete") {
      if (!job.name) throw new Error("automations delete requires name")
      const list = await deleteStoredAutomation(job.name)
      return { id: job.id, ok: true, kind: "automations", automations: list }
    }
    if (job.op === "clear") {
      await clearStoredAutomations()
      return { id: job.id, ok: true, kind: "automations", automations: [] }
    }
    const list = await listStoredAutomations()
    return { id: job.id, ok: true, kind: "automations", automations: list }
  }
  // LinkedIn-only jobs from here down. IMPORTANT: only these open/hijack a
  // LinkedIn tab — never call getLinkedInTab() as a shared preamble, or an
  // unrecognized job kind (e.g. a newer CLI command hitting an older build)
  // would spawn linkedin.com/feed as a surprise side effect.
  if (job.kind === "probe") {
    const tabId = await getLinkedInTab()
    await navigate(tabId, peopleSearchUrl(job.query, 1), "/search/results/people", "main")
    const data = await sendCmd(tabId, { cmd: "probe" })
    return { id: job.id, ok: true, kind: "probe", data }
  }
  if (job.kind === "probeProfile") {
    const tabId = await getLinkedInTab()
    // If a full URL is given, navigate to it verbatim (lets us probe /details/ pages);
    // otherwise resolve a slug/name to the canonical profile URL.
    const url = /^https?:/i.test(job.target.trim())
      ? job.target.trim()
      : await resolveProfileUrl(tabId, job.target)
    const expect = url.match(/\/in\/[^/?#]+/)?.[0] ?? "/in/"
    // Permissive anchor so the probe can dump structure regardless of layout.
    await navigate(tabId, url, expect, "main, section, h1")
    const data = await sendCmd(tabId, { cmd: "probeProfile" })
    return { id: job.id, ok: true, kind: "probe", data }
  }
  if (job.kind === "search") {
    const tabId = await getLinkedInTab()
    const hits = await runSearch(tabId, job.query, Math.max(1, job.pages))
    return { id: job.id, ok: true, kind: "search", hits }
  }
  if (job.kind === "profile") {
    const tabId = await getLinkedInTab()
    const profile = await runProfile(tabId, job.target)
    return { id: job.id, ok: true, kind: "profile", profile }
  }
  // Unknown kind — surface it WITHOUT any side effect (no LinkedIn tab).
  return { id: (job as Job).id, ok: false, error: `Unknown job kind "${(job as Job).kind}" — reload the extension to the latest build.` }
}

/* ------------------------------ entry point ----------------------------- */

/** Append a compact entry to the recent-job ring buffer (for the popup). */
async function recordJob(kind: string, ok: boolean, detail: string): Promise<void> {
  try {
    const { jobHistory } = await chrome.storage.local.get("jobHistory")
    const list: unknown[] = Array.isArray(jobHistory) ? jobHistory : []
    list.unshift({ kind, ok, detail: (detail || "").slice(0, 80), at: Date.now() })
    await chrome.storage.local.set({
      jobHistory: list.slice(0, 15),
      lastJobAt: Date.now(),
      lastJobKind: kind,
      lastJobOk: ok,
    })
  } catch {
    /* storage best-effort */
  }
}

/** One-line summary of a job for the history feed. */
function jobDetail(job: Job): string {
  switch (job.kind) {
    case "read":
      return job.url ?? "(current tab)"
    case "search":
      return job.query
    case "profile":
      return job.target
    case "eval":
      return job.code.replace(/\s+/g, " ").slice(0, 60)
    case "act":
      return job.actions.map((a) => a.action).join(", ")
    case "monitor":
      return job.op
    case "logs":
    case "network":
      return job.tab ?? "bridge"
    case "tabs":
      return job.op
    case "automations":
      return `${job.op}${job.name ? " " + job.name : ""}${job.automation ? " " + job.automation.name : ""}`
    default:
      return ""
  }
}

let autoRunLock: Promise<void> | null = null

async function startLocalAutomation(name: string, input?: Record<string, unknown>): Promise<{
  ok: boolean
  status: string
  summary?: string
  error?: string
}> {
  if (autoRunLock) throw new Error("An automation is already running")
  const stored = await getStoredAutomation(name)
  if (!stored) throw new Error(`Automation "${name}" not found in extension library. Run: bridge auto sync`)

  let resolveLock!: () => void
  autoRunLock = new Promise<void>((r) => {
    resolveLock = r
  })

  try {
    await setAutoRun({ status: "running", name, log: [], cancel: false, at: Date.now() })
    const result = await runRecipeInExtension({
      recipe: stored.recipe as RecipeLike,
      input,
      tab: "active",
      api: {
        act: async (actions, tab, withSnapshot) =>
          runActions(actions as never, tab, withSnapshot !== false, false),
        eval: (code, arg, timeout, tab) => runEval(code, arg, timeout, tab),
        snapshot: (tab) => runSnapshot(tab),
      },
      isCancelled: async () => {
        const s = await getAutoRun()
        return s.cancel === true
      },
      onProgress: (p) => {
        void setAutoRun({
          status: p.status === "running" ? "running" : p.status,
          name: p.name,
          step: p.step,
          log: p.log.slice(-30),
          error: p.error,
          summary: p.summary,
          at: Date.now(),
        })
      },
    })
    await setAutoRun({
      status: result.status,
      name: result.name,
      step: result.step,
      log: result.log.slice(-40),
      error: result.error,
      summary: result.summary,
      at: Date.now(),
    })
    void recordJob(`auto:${name}`, result.status === "done", result.summary || result.error || "")
    return {
      ok: result.status === "done",
      status: result.status,
      summary: result.summary,
      error: result.error,
    }
  } finally {
    resolveLock()
    autoRunLock = null
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // State reports from the offscreen doc (it can't write storage itself).
  if (msg?.type === "ws-state") {
    void chrome.storage.local.set(msg.patch as Record<string, unknown>)
    return
  }
  if (msg?.type === "auto-list") {
    void listStoredAutomations().then((automations) => sendResponse({ ok: true, automations }))
    return true
  }
  if (msg?.type === "auto-run-state") {
    void getAutoRun().then((state) => sendResponse({ ok: true, state }))
    return true
  }
  if (msg?.type === "auto-cancel") {
    void requestAutoCancel().then(() => sendResponse({ ok: true }))
    return true
  }
  if (msg?.type === "auto-run") {
    const name = String(msg.name || "")
    void startLocalAutomation(name, msg.input as Record<string, unknown> | undefined)
      .then((r) => sendResponse(r))
      .catch((err) =>
        sendResponse({ ok: false, status: "failed", error: err instanceof Error ? err.message : String(err) })
      )
    return true
  }
  if (msg?.type !== "job") return
  const job = msg.job as Job
  const detail = jobDetail(job)
  runJob(job)
    .then((result) => {
      void recordJob(job.kind, result.ok, result.ok ? detail : (result as { error: string }).error)
      sendResponse(result)
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      void recordJob(job.kind, false, message)
      sendResponse({ id: job.id, ok: false, error: message })
    })
  return true // async response
})
