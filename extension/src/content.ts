/**
 * Content script: a STATELESS scraper executor.
 *
 * It owns no job state — the background SW drives navigation and issues
 * granular commands ("scrape the current page"). This keeps jobs robust
 * across LinkedIn's SPA navigations, which routinely tear down this script.
 */

import { waitForElement } from "./lib/dom-helpers"
import { delay, scrollThroughPage, simulateReading } from "./lib/pacing"
import { scrapeSearchPage } from "./lib/scrape-search"
import { scrapeMainProfile } from "./lib/scrape-profile"

export type ContentCommand =
  | { cmd: "ping" }
  | { cmd: "waitAnchor"; selector: string; timeout?: number }
  | { cmd: "scrapeSearch" }
  | { cmd: "scrapeProfileMain" }
  | { cmd: "probe" }
  | { cmd: "probeProfile" }

/** Debug helper: report the real DOM structure of a profile / details page. */
const probeProfile = () => {
  const c = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim()
  const sections = Array.from(document.querySelectorAll("section"))
  const byTextLen = [...sections].sort(
    (a, b) => (b.textContent?.length ?? 0) - (a.textContent?.length ?? 0)
  )
  const mainUl = document.querySelector("main ul")
  const mainListItem = mainUl?.querySelector(":scope > li") ?? mainUl?.children?.[0] ?? null
  return {
    url: location.href,
    title: document.title,
    sectionCount: sections.length,
    sections: sections.slice(0, 20).map((s) => ({
      heading: c(s.querySelector("h2, h3")?.textContent).slice(0, 60),
      preview: c(s.textContent).slice(0, 140),
    })),
    followersConnections: Array.from(document.querySelectorAll("main span, main p, main li"))
      .map((e) => c(e.textContent))
      .filter((t) => /\b[\d.,]+\+?\s*(followers|connections|connexions|relations)\b/i.test(t) && t.length < 60)
      .slice(0, 6),
    // Inner HTML of the two text-richest sections (top card, etc.)
    bigSectionsHTML: byTextLen.slice(0, 2).map((s) => c(s.outerHTML).slice(0, 2400)),
    // First list item under <main> — the entry shape on /details/ pages.
    mainListItemHTML: c(mainListItem?.outerHTML).slice(0, 2400),
  }
}

/** Debug helper: report the real DOM structure of the current page. */
const probe = () => {
  const viewNames: Record<string, number> = {}
  document.querySelectorAll<HTMLElement>("[data-view-name]").forEach((el) => {
    const n = el.getAttribute("data-view-name") ?? "?"
    viewNames[n] = (viewNames[n] ?? 0) + 1
  })
  const lists = Array.from(document.querySelectorAll('ul[role="list"], div[role="list"]'))
  const listInfo = lists.map((ul) => ({
    tag: ul.tagName.toLowerCase(),
    className: (ul.className || "").slice(0, 80),
    children: ul.children.length,
    liCount: ul.querySelectorAll(":scope > li").length,
  }))
  const inLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]'))
  const firstLink = inLinks[0] ?? null
  const linkContainer = firstLink?.closest("li") ?? firstLink?.parentElement ?? null
  return {
    url: location.href,
    title: document.title,
    viewNames,
    lists: listInfo,
    inLinkCount: inLinks.length,
    firstInLinkHref: firstLink?.getAttribute("href") ?? null,
    firstInLinkText: (firstLink?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    sampleContainerHTML: (linkContainer?.outerHTML ?? "").slice(0, 2200),
  }
}

const handle = async (msg: ContentCommand): Promise<unknown> => {
  switch (msg.cmd) {
    case "ping":
      return { ok: true, url: location.href }

    case "probe":
      await delay(600)
      await simulateReading(2000, 3500)
      return probe()

    case "probeProfile":
      await delay(600)
      await scrollThroughPage()
      return probeProfile()

    case "waitAnchor": {
      const el = await waitForElement(
        () => document.querySelector(msg.selector),
        msg.timeout ?? 12000,
        250
      )
      return { found: Boolean(el), url: location.href }
    }

    case "scrapeSearch": {
      await delay(800)
      await simulateReading(2500, 5000) // load lazy result cards
      return { hits: scrapeSearchPage() }
    }

    case "scrapeProfileMain": {
      await delay(800)
      await scrollThroughPage() // nudge lazy top card + activity into the DOM
      return { profile: scrapeMainProfile() }
    }

    default:
      return { error: "unknown command" }
  }
}

chrome.runtime.onMessage.addListener((msg: ContentCommand, _sender, sendResponse) => {
  if (!msg || typeof (msg as { cmd?: string }).cmd !== "string") return
  handle(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }))
  return true // async response
})

console.debug("[browser-bridge] content script ready", location.href)
