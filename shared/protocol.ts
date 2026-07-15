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
    | "scroll"
    | "mouseMove"
    | "waitFor"
    | "waitForUrl"
    | "submit"
    | "getText"
    | "getValue"
    | "eval"
    | "navigate"
  target?: string
  text?: string
  value?: string
  key?: string
  url?: string
  timeout?: number
  /** action "eval": arbitrary JS run in the page (MAIN world). `return` a value. */
  code?: string
  /** action "eval": optional argument passed to the code as `arg`. */
  arg?: unknown
  /** action "eval": bind the returned value under this name in the batch's `vars`. */
  as?: string
  /** action "scroll": pixels to scroll vertically (default a viewport), or "top"/"bottom" via `target`. */
  deltaY?: number
  /** click/scroll/mouseMove: simulate human pacing — jittered multi-step motion + delays. */
  human?: boolean
  /** scroll: number of human sub-steps (default auto). mouseMove: path points. */
  steps?: number
  /** mouseMove: absolute viewport coordinates (alternative to `target`). */
  x?: number
  y?: number
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
  /** When true, keep running steps after one fails (default: fail-fast). */
  continueOnError?: boolean
}

/**
 * Run arbitrary JS in a page (MAIN world) and return the value. This is the
 * extensibility primitive: an agent can write any script and execute it.
 * The code runs as the body of an async function — use `return` to send a
 * (JSON-serializable) value back, and `await` freely. `arg` is exposed as `arg`.
 */
export interface EvalJob {
  id: string
  kind: "eval"
  code: string
  tab?: TabTarget
  arg?: unknown
  /** Max ms to await an async result before erroring (default 15000). */
  timeout?: number
}

/**
 * Console + network capture (NON-CDP — no chrome.debugger, no banner).
 * `monitor` arms/disarms a MAIN-world hook that wraps console.*, window
 * errors, fetch and XHR; `logs`/`network` read the per-page buffer back.
 * Fidelity note: captures app-level fetch/XHR (not static resource loads) and
 * only what happens after the hook installs (reload to capture from page load).
 */
export interface MonitorJob {
  id: string
  kind: "monitor"
  op: "start" | "stop" | "status"
}

export interface CaptureJob {
  id: string
  kind: "logs" | "network"
  tab?: TabTarget
  /** Clear the buffer after reading. */
  clear?: boolean
}

/** Automation synced into the extension for popup listing / one-click replay. */
export interface StoredAutomation {
  name: string
  description?: string
  /** Hostnames for grouping in the popup (e.g. "example.com", "127.0.0.1"). */
  sites: string[]
  /** Full recipe object (JSON-serializable). */
  recipe: unknown
  updatedAt: number
}

/** Push / remove / list automations in extension storage (popup library). */
export interface AutomationsJob {
  id: string
  kind: "automations"
  op: "upsert" | "delete" | "list" | "clear"
  automation?: StoredAutomation
  name?: string
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
  | EvalJob
  | MonitorJob
  | CaptureJob
  | TabsJob
  | ScreenshotJob
  | AutomationsJob

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

/** One captured console message or page error. */
export interface LogEntry {
  level: string
  text: string
  t: number
}

/** One captured network call (app-level fetch/XHR). */
export interface NetEntry {
  type: string
  method: string
  url: string
  status: number
  ms: number
  t: number
  error?: string
  /** Response body, truncated, when small + text/JSON. */
  body?: string
}

/** Outcome of a single action step. */
export interface StepResult {
  action: string
  target?: string
  ok: boolean
  value?: string
  /** Structured result (e.g. from an "eval" or "getValue" step). */
  json?: unknown
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
  | { id: string; ok: true; kind: "eval"; url: string; value: unknown }
  | { id: string; ok: true; kind: "monitor"; active: boolean }
  | { id: string; ok: true; kind: "logs"; url: string; logs: LogEntry[] }
  | { id: string; ok: true; kind: "network"; url: string; requests: NetEntry[] }
  | { id: string; ok: true; kind: "tabs"; tabs: TabInfo[] }
  | { id: string; ok: true; kind: "screenshot"; dataUrl: string }
  | { id: string; ok: true; kind: "automations"; automations: StoredAutomation[] }
  | { id: string; ok: false; error: string }
