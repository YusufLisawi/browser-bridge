/**
 * Human-like pacing helpers.
 *
 * NOTE (honest limitation): synthetic events dispatched here have
 * isTrusted=false and do NOT move the real OS cursor. They make the page
 * *behave* as if scrolled/hovered (triggering lazy-load, etc.) and add
 * realistic timing, but LinkedIn's client telemetry can still distinguish
 * them from genuine input. The real protection is LOW VOLUME — see the
 * rate caps enforced CLI-side. Pacing reduces velocity flags; it does not
 * defeat trust-signal detection.
 */

/** Resolve after `ms` plus 0–1000ms of jitter. */
export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms + Math.random() * 1000))

/** Small per-keystroke delay. */
export const humanKeyDelay = (min = 10, max = 50): Promise<void> =>
  new Promise((resolve) => {
    const span = Math.max(0, max - min)
    window.setTimeout(resolve, min + Math.random() * span)
  })

export const randomBetween = (min: number, max: number): number => {
  if (max < min) return min
  return min + Math.floor(Math.random() * (max - min + 1))
}

/** Dispatch a few synthetic mousemove events along a jittery path. */
export const wiggleMouse = (steps = 6): void => {
  let x = randomBetween(40, window.innerWidth - 40)
  let y = randomBetween(80, window.innerHeight - 80)
  for (let i = 0; i < steps; i += 1) {
    x = Math.max(0, Math.min(window.innerWidth, x + randomBetween(-60, 60)))
    y = Math.max(0, Math.min(window.innerHeight, y + randomBetween(-40, 40)))
    const target = document.elementFromPoint(x, y) ?? document.body
    target?.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y })
    )
  }
}

/**
 * Scroll + dwell like a human reading the page. Drives lazy-loaded LinkedIn
 * sections into the DOM. Adapted from gain-booster simulateProfileView.
 */
export const simulateReading = async (
  minDurationMs = 4000,
  maxDurationMs = 9000
): Promise<void> => {
  const targetDuration = randomBetween(minDurationMs, maxDurationMs)
  const start = performance.now()
  const scroller = document.scrollingElement || document.documentElement || document.body

  while (performance.now() - start < targetDuration) {
    if (Math.random() > 0.6) wiggleMouse(3)
    scroller.scrollBy({ top: 150 + Math.random() * 120, behavior: "smooth" })
    await delay(450 + Math.random() * 500)
    if (Math.random() > 0.75) {
      scroller.scrollBy({ top: -90, behavior: "smooth" })
      await delay(350 + Math.random() * 300)
    }
  }
}

/** Scroll to the bottom in chunks to force lazy content, then back up a bit. */
export const scrollThroughPage = async (maxChunks = 12): Promise<void> => {
  const scroller = document.scrollingElement || document.documentElement || document.body
  let lastHeight = 0
  for (let i = 0; i < maxChunks; i += 1) {
    scroller.scrollBy({ top: 600 + Math.random() * 300, behavior: "smooth" })
    await delay(500 + Math.random() * 400)
    const height = scroller.scrollHeight
    if (height === lastHeight && i > 2) break
    lastHeight = height
  }
  scroller.scrollTo({ top: 0, behavior: "smooth" })
  await delay(400)
}
