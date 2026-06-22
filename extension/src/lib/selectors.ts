/**
 * LinkedIn selectors — trimmed/adapted from gain-booster auto-connect.
 * Text/aria-pattern + xpath based on purpose, because LinkedIn CSS class
 * names are hashed and rotate frequently.
 */

import { findButtonByPatterns, isElementVisible } from "./dom-helpers"

const NEW_RESULT_CARD_SELECTOR =
  '[role="list"] [data-view-name="search-entity-result-universal-template"]'
const OLD_RESULT_CARD_SELECTOR =
  'div[data-view-name="people-search-result"] > a > div'

const NEXT_PATTERNS = [/^next$/i]
const NEXT_LABEL_PATTERNS_MULTI: RegExp[] = [
  /^(next|siguiente|suivant|weiter|avanti|próximo|proximo|seguinte|volgende|sonraki|التالي)/i,
]

const matchesPatterns = (value: string, patterns: RegExp[]) =>
  patterns.some((p) => p.test(value))

const getElementLabel = (el: Element): string => {
  const text = el.textContent?.trim() ?? ""
  const ariaLabel = el.getAttribute("aria-label")?.trim() ?? ""
  return text || ariaLabel
}

const findAllActionElementsMatching = (
  patterns: RegExp[],
  root: Document | Element | ShadowRoot = document
): HTMLElement[] => {
  const all = Array.from(root.querySelectorAll<HTMLElement>("button, a[role='button'], a"))
  return all.filter((el) => {
    if (!isElementVisible(el)) return false
    const label = getElementLabel(el)
    return label ? matchesPatterns(label, patterns) : false
  })
}

/** Build a people-search results URL for a keyword and page. */
export const buildPeopleSearchUrl = (keyword: string, page = 1): string => {
  const url = new URL("https://www.linkedin.com/search/results/people/")
  url.searchParams.set("keywords", keyword)
  if (page && page > 1) url.searchParams.set("page", String(page))
  return url.toString()
}

const slugOf = (el: Element): string | null =>
  el.getAttribute("href")?.match(/\/in\/([^/?#]+)/)?.[1] ?? null

/**
 * All people-search result cards on the current page.
 *
 * Current LinkedIn (2024+): each result is an `<a href="/in/...">` that wraps
 * the whole card (it contains `<p>` blocks for name/headline/location), living
 * inside a `[role="list"]`. Class names are fully hashed, so we anchor on that
 * structure. Falls back to the older `data-view-name` UIs.
 */
export const getResultCards = (): Element[] => {
  // Pick the [role=list] that holds the most profile links (skips sidebars).
  const lists = Array.from(document.querySelectorAll('[role="list"]'))
  let root: ParentNode = document
  let best = 0
  for (const list of lists) {
    const count = list.querySelectorAll('a[href*="/in/"]').length
    if (count > best) {
      best = count
      root = list
    }
  }

  const anchors = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/in/"]')).filter(
    (a) => a.querySelector("p") // the wrapping card anchor contains <p>; the inner name anchor does not
  )
  const seen = new Set<string>()
  const cards: Element[] = []
  for (const anchor of anchors) {
    const slug = slugOf(anchor)
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    cards.push(anchor)
  }
  if (cards.length) return cards

  // Legacy fallbacks
  const universal = Array.from(document.querySelectorAll(NEW_RESULT_CARD_SELECTOR))
  if (universal.length) return universal
  return Array.from(document.querySelectorAll(OLD_RESULT_CARD_SELECTOR))
}

/** Primary profile link inside a result card. */
export const findPrimaryProfileLink = (card: Element): HTMLAnchorElement | null =>
  card.querySelector<HTMLAnchorElement>('a[href*="/in/"]') ??
  card.querySelector<HTMLAnchorElement>('a[href^="https://www.linkedin.com/in/"]') ??
  null

/** The "Next" pagination control. */
export const findNextPageButton = (): HTMLElement | null =>
  findAllActionElementsMatching(NEXT_LABEL_PATTERNS_MULTI)[0] ??
  (findButtonByPatterns(NEXT_PATTERNS) as unknown as HTMLElement | null)

export const isSearchResultsPage = (): boolean =>
  window.location.pathname.startsWith("/search/results/people")

export const isProfilePage = (): boolean =>
  window.location.pathname.startsWith("/in/")
