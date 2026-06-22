/**
 * Scrape a LinkedIn profile from its FIRST page only (2024+ redesign).
 * One page load, no /details/ navigation. We parse the top card (name,
 * headline, current company/school, location, followers/connections) and the
 * latest post from the Activity card (text + relative time). Tolerant: missing
 * fields return null rather than throwing.
 */

import type { LatestPost, ProfileData } from "../../../shared/protocol"

const clean = (s: string | null | undefined): string | null => {
  const v = (s ?? "").replace(/\s+/g, " ").trim()
  return v || null
}

const SCHOOL_RE = /(university|college|school|institute|academy|universit|école|hochschule)/i
const NOISE_RE =
  /^(message|connect|follow|following|pending|more|save|share|contact info|see contact info|·|•)/i
// Relative post time immediately followed by a separator, e.g. "2w •".
const POST_TIME_RE = /\b(\d+)\s*(s|m|h|d|w|mo|yr|sec|min|hour|day|week|month|year)s?\b\s*[•·]/i

const primaryContent = (): Element =>
  document.querySelector('section[aria-label="Primary content"]') ?? document.body

/** Deepest (leaf) text lines within a root, in DOM order, de-duplicated. */
const leafLines = (root: Element): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  root.querySelectorAll<HTMLElement>("h1, h2, h3, p, span, a, li").forEach((el) => {
    if (Array.from(el.children).some((ch) => (ch.textContent ?? "").trim())) return
    const t = clean(el.textContent)
    if (t && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  })
  return out
}

const nameFromTitle = (): string | null => clean(document.title.replace(/\s*[|·].*$/, ""))

const cleanProfileUrl = (): string | null => {
  const m = location.pathname.match(/\/in\/([^/?#]+)/)
  return m ? `https://www.linkedin.com/in/${m[1]}/` : location.href
}

/** The top card section (holds name/headline/company/school/location). */
const topCard = (): Element => {
  const root = primaryContent()
  const card =
    root.querySelector('[componentkey*="Topcard"]') ??
    root.querySelector("section") ??
    root
  return card
}

const POST_NOISE_RE =
  /^(video player is loading|beginning of dialog|escape will cancel|end of dialog|this is a modal|play|pause|mute|unmute|posts|videos|loaded|follow|like|liked|comment|repost|reposted|\d+:\d+|\d+\s*(likes?|comments?|reposts?))/i

const scrapeLatestPost = (): LatestPost | null => {
  const root = primaryContent()
  const lines = leafLines(root)
  const idx = lines.findIndex((l) => POST_TIME_RE.test(l))
  if (idx === -1) return null
  const m = lines[idx].match(POST_TIME_RE)
  const time = m ? `${m[1]}${m[2].toLowerCase()}` : null

  // Commentary often lives in a <span dir="ltr">/<p> with nested hashtag links
  // (so it isn't a "leaf"). Pull prose elements too, then take the longest
  // real text block in the post area — not the first line after the timestamp
  // (which can be a video/media or dialog a11y placeholder).
  const prose = Array.from(root.querySelectorAll<HTMLElement>("p, span[dir], div[dir]")).map(
    (e) => clean(e.textContent)
  )
  const candidates = [...lines.slice(idx), ...prose]
    .map((l) => (l ?? "").replace(/^\s*\d+\s*(?:s|m|h|d|w|mo|yr)\w*\s*[•·]\s*/i, "").trim())
    .filter(
      (l) => l.length > 25 && l.length < 3000 && !POST_NOISE_RE.test(l) && !POST_TIME_RE.test(l)
    )
  const text = candidates.sort((a, b) => b.length - a.length)[0] ?? null
  return { text: text ? text.slice(0, 1500) : null, time }
}

export const scrapeMainProfile = (): ProfileData => {
  const name = nameFromTitle()
  const card = topCard()
  const lines = leafLines(card).filter(
    (l) => l !== name && !NOISE_RE.test(l) && !/^(1st|2nd|3rd)\+?$/i.test(l)
  )

  const headline = lines[0] ?? null

  // Location: a geographic line ("City, Region, Country") — 2+ commas distinguishes
  // it from the headline (which may contain a single comma, e.g. "CEO, NVIDIA").
  const locIdx = lines.findIndex(
    (l) => (l.match(/,/g)?.length ?? 0) >= 2 && !/[·•]/.test(l)
  )
  const location = locIdx >= 0 ? lines[locIdx] : null

  // Company/school chips sit between the headline and the location. LinkedIn
  // often renders them as one "Company · School" chip, so split on the middot.
  const chips = lines
    .slice(1, locIdx >= 0 ? locIdx : 4)
    .flatMap((l) => l.split(/[·•]/).map((s) => s.trim()))
    .filter((l) => l && l !== headline && !NOISE_RE.test(l))
  const currentSchool = chips.find((l) => SCHOOL_RE.test(l)) ?? null
  const currentCompany = chips.find((l) => l !== currentSchool) ?? null

  const pageText = `${primaryContent().textContent ?? ""} ${document.body.textContent ?? ""}`
  const followersMatch = pageText.match(/([\d.,]+)\s*(followers|abonnés|seguidores|follower)/i)
  const followers = followersMatch
    ? Number.parseInt(followersMatch[1].replace(/[.,]/g, ""), 10)
    : null
  const connMatch = pageText.match(
    /([\d.,]+\+?)\s*(connections|connexions|relations|contactos|contatti|kontakte)/i
  )

  return {
    profileUrl: cleanProfileUrl(),
    name,
    headline: clean(headline),
    location: clean(location),
    followers: followers != null && !Number.isNaN(followers) ? followers : null,
    connections: connMatch ? clean(connMatch[0].replace(/(\d)\s*\+?\s*(connections)/i, "$1+ $2")) : null,
    currentCompany: clean(currentCompany),
    currentSchool: clean(currentSchool),
    latestPost: scrapeLatestPost(),
  }
}
