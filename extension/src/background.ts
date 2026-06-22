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
} from "../../shared/protocol"
import type { ContentCommand } from "./content"

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
    const el = resolve(step.target)
    if (!el && a !== "press") return { ...res, error: "element not found: " + step.target }
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" })
    switch (a) {
      case "click":
        el.focus?.()
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
        el.click()
        break
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

async function runActions(actions: any[], target?: string, withSnapshot = true) {
  const tabId = await resolveTab(target)
  const results: unknown[] = []
  for (const step of actions) {
    if (step.action === "navigate") {
      let host = ""
      try {
        host = new URL(step.url).hostname
      } catch {}
      await chrome.tabs.update(tabId, { url: step.url })
      await waitForComplete(tabId, host, 30000)
      await sleep(600)
      results.push({ action: "navigate", target: step.url, ok: true })
      continue
    }
    const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: bbExec, args: [{ op: "act", step }] })
    results.push(inj.result)
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
    const r = await runActions(job.actions, job.tab, job.snapshot !== false)
    return { id: job.id, ok: true, kind: "act", url: r.url, results: r.results as never, snapshot: r.snapshot }
  }
  const tabId = await getLinkedInTab()
  if (job.kind === "probe") {
    await navigate(tabId, peopleSearchUrl(job.query, 1), "/search/results/people", "main")
    const data = await sendCmd(tabId, { cmd: "probe" })
    return { id: job.id, ok: true, kind: "probe", data }
  }
  if (job.kind === "probeProfile") {
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
    const hits = await runSearch(tabId, job.query, Math.max(1, job.pages))
    return { id: job.id, ok: true, kind: "search", hits }
  }
  if (job.kind === "profile") {
    const profile = await runProfile(tabId, job.target)
    return { id: job.id, ok: true, kind: "profile", profile }
  }
  return { id: (job as Job).id, ok: false, error: `Unknown job kind — reload the extension to the latest build.` }
}

/* ------------------------------ entry point ----------------------------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // State reports from the offscreen doc (it can't write storage itself).
  if (msg?.type === "ws-state") {
    void chrome.storage.local.set(msg.patch as Record<string, unknown>)
    return
  }
  if (msg?.type !== "job") return
  const job = msg.job as Job
  runJob(job)
    .then(sendResponse)
    .catch((err) =>
      sendResponse({ id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    )
  return true // async response
})
