/**
 * Wire protocol shared by the CLI (Node) and the extension.
 *
 * Flow:
 *   CLI server  --Job-->        offscreen (WS client)
 *   offscreen   --runtime msg-> background service worker
 *   background  --tabs msg-->   content script (per scrape step)
 *   ...result travels back the same chain as JobResult.
 */

export const WS_PORT = 8787
export const WS_HOST = "127.0.0.1"
export const WS_URL = `ws://${WS_HOST}:${WS_PORT}`

/* ------------------------------- Jobs ----------------------------------- */

export interface SearchJob {
  id: string
  kind: "search"
  /** Free-text people-search query, e.g. "react developer berlin". */
  query: string
  /** Number of result pages to scrape (1 = first page only). */
  pages: number
}

export interface ProfileJob {
  id: string
  kind: "profile"
  /** A profile URL, a /in/ slug, or a person's name (resolved via search). */
  target: string
  /** When true, also visit /details/experience|education + recent-activity. */
  deep: boolean
}

export interface PingJob {
  id: string
  kind: "ping"
}

/** Debug-only: navigate to a search page and return DOM structure hints. */
export interface ProbeJob {
  id: string
  kind: "probe"
  query: string
}

/** Debug-only: navigate to a profile and return DOM structure hints. */
export interface ProfileProbeJob {
  id: string
  kind: "probeProfile"
  target: string
}

/** Generic: read a page as content. With `url`, navigate first; without, read
 *  the resolved tab's current page. */
export interface ReadJob {
  id: string
  kind: "read"
  url?: string
  tab?: TabTarget
}

/** Which tab an action targets: "bridge" (background tab), "active", or a tab id string. */
export type TabTarget = string

export interface TabInfo {
  id: number
  active: boolean
  title: string
  url: string
  windowId: number
}

/** List / manage browser tabs. */
export interface TabsJob {
  id: string
  kind: "tabs"
  op: "list" | "activate" | "close" | "new"
  tabId?: number
  url?: string
}

/** Capture a PNG of a tab (returned as a data URL, written to a file CLI-side). */
export interface ScreenshotJob {
  id: string
  kind: "screenshot"
  tab?: TabTarget
}

/** One browser action. `target` is a snapshot ref ("e7") or a CSS/XPath selector. */
export interface ActionStep {
  action:
    | "click"
    | "fill"
    | "type"
    | "setValue"
    | "select"
    | "check"
    | "uncheck"
    | "press"
    | "hover"
    | "focus"
    | "scrollIntoView"
    | "waitFor"
    | "submit"
    | "getText"
    | "getValue"
    | "navigate"
  target?: string
  text?: string
  value?: string
  key?: string
  url?: string
  timeout?: number
}

/** Snapshot the interactive elements of a page (the LLM's "eyes"). */
export interface SnapshotJob {
  id: string
  kind: "snapshot"
  tab?: TabTarget
}

/** Run a sequence of actions, then (by default) return a fresh snapshot. */
export interface ActJob {
  id: string
  kind: "act"
  actions: ActionStep[]
  tab?: TabTarget
  snapshot?: boolean
}

export type Job =
  | SearchJob
  | ProfileJob
  | PingJob
  | ProbeJob
  | ProfileProbeJob
  | ReadJob
  | SnapshotJob
  | ActJob
  | TabsJob
  | ScreenshotJob

/* ------------------------------ Results --------------------------------- */

export interface SearchHit {
  name: string | null
  headline: string | null
  location: string | null
  profileUrl: string | null
  connectionDegree: string | null
}

/** The latest post highlighted on the profile's first page (Activity card). */
export interface LatestPost {
  text: string | null
  /** Relative time as shown, e.g. "2w", "3d", "5h". */
  time: string | null
}

/**
 * Everything scrapeable from the FIRST profile page in one load — no /details/
 * navigation. "Latest experience" is the top card's current role/company.
 */
export interface ProfileData {
  profileUrl: string | null
  name: string | null
  headline: string | null
  location: string | null
  /** Numeric follower count when parseable, else null. */
  followers: number | null
  /** Raw connections text, e.g. "500+ connections" — locale-dependent. */
  connections: string | null
  /** Current company from the top card (the latest experience). */
  currentCompany: string | null
  /** Most recent school from the top card. */
  currentSchool: string | null
  /** Latest post from the Activity card, if any. */
  latestPost: LatestPost | null
}

/** A link found on a page. */
export interface Link {
  href: string
  text: string
}

/** Contact signals scraped from the whole page (useful for lead-gen). */
export interface Contacts {
  emails: string[]
  phones: string[]
  socials: string[]
}

/** Raw readable content extracted from a page (HTML → Markdown is done CLI-side). */
export interface PageContent {
  url: string
  title: string
  html: string
  links: Link[]
  contacts: Contacts
}

/** One interactive element in a page snapshot. */
export interface SnapNode {
  ref: string
  tag: string
  type?: string
  role?: string
  name?: string
  value?: string
  placeholder?: string
  checked?: boolean
  options?: string[]
  href?: string
  disabled?: boolean
}

/** Outcome of a single action step. */
export interface StepResult {
  action: string
  target?: string
  ok: boolean
  value?: string
  error?: string
}

export type JobResult =
  | { id: string; ok: true; kind: "search"; hits: SearchHit[] }
  | { id: string; ok: true; kind: "profile"; profile: ProfileData }
  | { id: string; ok: true; kind: "ping" }
  | { id: string; ok: true; kind: "probe"; data: unknown }
  | { id: string; ok: true; kind: "read"; page: PageContent }
  | { id: string; ok: true; kind: "snapshot"; url: string; title: string; elements: SnapNode[] }
  | { id: string; ok: true; kind: "act"; url: string; results: StepResult[]; snapshot?: SnapNode[] }
  | { id: string; ok: true; kind: "tabs"; tabs: TabInfo[] }
  | { id: string; ok: true; kind: "screenshot"; dataUrl: string }
  | { id: string; ok: false; error: string }
