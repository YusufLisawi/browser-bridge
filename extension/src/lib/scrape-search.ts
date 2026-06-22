/**
 * Scrape people-search result cards on the CURRENT page into SearchHit[].
 * Tolerant by design: a card that doesn't parse yields nulls, never throws.
 */

import type { SearchHit } from "../../../shared/protocol"
import { getResultCards, findPrimaryProfileLink } from "./selectors"

const clean = (s: string | null | undefined): string | null => {
  const v = (s ?? "").replace(/\s+/g, " ").trim()
  return v || null
}

/** Strip query/hash and trailing slash noise off an /in/ profile URL. */
const cleanProfileUrl = (href: string | null): string | null => {
  if (!href) return null
  try {
    const u = new URL(href, "https://www.linkedin.com")
    const match = u.pathname.match(/\/in\/([^/?#]+)/)
    if (!match) return u.origin + u.pathname
    return `https://www.linkedin.com/in/${match[1]}/`
  } catch {
    return href
  }
}

const NOISE_RE = /^(message|connect|follow|following|pending|view\b)/i

/**
 * Parse one result card. Current LinkedIn nests name/headline/location in
 * `<p>` blocks; the name lives in a nested `<a href="/in/...">`. Falls back to
 * raw text lines for older UIs.
 */
const parseCard = (card: Element): SearchHit => {
  const nested = findPrimaryProfileLink(card)
  const cardHref = card.getAttribute("href")
  const profileUrl = cleanProfileUrl(cardHref ?? nested?.getAttribute("href") ?? null)

  // Connection degree: "• 2nd", "3rd+", etc., anywhere in the card text.
  const degreeMatch = (card.textContent ?? "").match(/\b(1st|2nd|3rd)\+?\b/i)
  const connectionDegree = degreeMatch ? degreeMatch[0] : null

  // Name: nested profile-link text (e.g. "Steve Wauson").
  let name = clean(nested?.textContent)?.replace(/\s*•.*$/, "").trim() || null

  // Headline + location: the <p> blocks that are NOT the name's <p>.
  const namePEl = nested?.closest("p")
  const infoLines = Array.from(card.querySelectorAll("p"))
    .filter((p) => p !== namePEl)
    .map((p) => clean(p.textContent))
    .filter((l): l is string => l !== null && !NOISE_RE.test(l))

  // Old-UI fallback when there are no <p> blocks.
  if (!infoLines.length) {
    const lines = (card.textContent ?? "")
      .split("\n")
      .map((l) => clean(l))
      .filter((l): l is string => l !== null && !NOISE_RE.test(l))
    if (!name) name = lines[0] ?? null
    return {
      name,
      headline: lines.find((l) => l !== name) ?? null,
      location: null,
      profileUrl,
      connectionDegree,
    }
  }

  return {
    name,
    headline: infoLines[0] ?? null,
    location: infoLines[1] ?? null,
    profileUrl,
    connectionDegree,
  }
}

export const scrapeSearchPage = (): SearchHit[] =>
  getResultCards()
    .map(parseCard)
    .filter((hit) => hit.profileUrl || hit.name)
