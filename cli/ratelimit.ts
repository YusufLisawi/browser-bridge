/**
 * Cross-invocation rate caps, persisted to ~/.browser-bridge/usage.json.
 *
 * Per advisor: the real protection against an account ban is LOW VOLUME, not
 * believable humanity. These caps REFUSE the offending request — they never
 * delay-then-send. Tune via env vars if you must, but tune them DOWN.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DIR = join(homedir(), ".browser-bridge")
const FILE = join(DIR, "usage.json")

const MAX_PROFILES_PER_DAY = Number(process.env.BRIDGE_MAX_PROFILES_PER_DAY ?? 30)
const MAX_SEARCHES_PER_HOUR = Number(process.env.BRIDGE_MAX_SEARCHES_PER_HOUR ?? 10)

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

type EventType = "profile" | "search"
interface UsageEvent { ts: number; type: EventType }

function load(): UsageEvent[] {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as UsageEvent[]
  } catch {
    return []
  }
}

function save(events: UsageEvent[]): void {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(events.slice(-2000)), "utf8")
}

function countWithin(events: UsageEvent[], type: EventType, windowMs: number): number {
  const cutoff = Date.now() - windowMs
  return events.filter((e) => e.type === type && e.ts >= cutoff).length
}

/** Throw a clear error if this request would exceed a cap. */
export function assertWithinLimit(type: EventType): void {
  const events = load()
  if (type === "profile") {
    const used = countWithin(events, "profile", DAY_MS)
    if (used >= MAX_PROFILES_PER_DAY) {
      throw new Error(
        `Daily profile cap reached (${used}/${MAX_PROFILES_PER_DAY}). ` +
          `Protect the account — try again tomorrow, or raise BRIDGE_MAX_PROFILES_PER_DAY at your own risk.`
      )
    }
  } else {
    const used = countWithin(events, "search", HOUR_MS)
    if (used >= MAX_SEARCHES_PER_HOUR) {
      throw new Error(
        `Hourly search cap reached (${used}/${MAX_SEARCHES_PER_HOUR}). ` +
          `Wait, or raise BRIDGE_MAX_SEARCHES_PER_HOUR at your own risk.`
      )
    }
  }
}

/** How many more of this type are allowed in the current window. */
export function remainingFor(type: EventType): number {
  const events = load()
  if (type === "profile") {
    return Math.max(0, MAX_PROFILES_PER_DAY - countWithin(events, "profile", DAY_MS))
  }
  return Math.max(0, MAX_SEARCHES_PER_HOUR - countWithin(events, "search", HOUR_MS))
}

/** Record a successful request against the caps. */
export function recordUsage(type: EventType): void {
  const events = load()
  events.push({ ts: Date.now(), type })
  save(events)
}
