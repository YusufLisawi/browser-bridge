/**
 * Generic DOM helpers — copied from gain-booster, Plasmo aliases removed.
 */

import { humanKeyDelay } from "./pacing"

/** Find single element using XPath. */
export const xpathOne = <T extends Element>(
  xpath: string,
  context: Document | Element = document
): T | null => {
  const result = document.evaluate(
    xpath,
    context,
    null,
    XPathResult.FIRST_ORDERED_NODE_TYPE,
    null
  )
  return (result.singleNodeValue as T | null) ?? null
}

/** Find multiple elements using XPath. */
export const xpathAll = <T extends Element>(
  xpath: string,
  context: Document | Element = document
): T[] => {
  const result = document.evaluate(
    xpath,
    context,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null
  )
  const elements: T[] = []
  for (let index = 0; index < result.snapshotLength; index += 1) {
    const node = result.snapshotItem(index)
    if (node) elements.push(node as T)
  }
  return elements
}

/** First button whose text or aria-label matches any provided pattern. */
export const findButtonByPatterns = (
  patterns: RegExp[],
  context: Document | Element = document
): HTMLButtonElement | null => {
  const buttons = Array.from(context.querySelectorAll("button"))
  const matched = buttons.find((button) => {
    const text = button.textContent?.trim() ?? ""
    const ariaLabel = button.getAttribute("aria-label")?.trim() ?? ""
    return patterns.some((p) => p.test(text) || p.test(ariaLabel))
  })
  return (matched as HTMLButtonElement) ?? null
}

/** First element matching any regex pattern within a selector scope. */
export const findElementByPatterns = (
  selector: string,
  patterns: RegExp[],
  context: Document | Element = document
): Element | null => {
  const elements = Array.from(context.querySelectorAll(selector))
  return (
    elements.find((el) => patterns.some((p) => p.test(el.textContent?.trim() ?? ""))) ??
    null
  )
}

/** Determine if an element is visible. */
export const isElementVisible = (element: Element | null): boolean => {
  if (!element) return false
  const rect = element.getBoundingClientRect()
  const styles = window.getComputedStyle(element)
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    styles.display !== "none" &&
    styles.visibility !== "hidden" &&
    styles.opacity !== "0"
  )
}

/** Wait for an element to appear using a finder callback. */
export const waitForElement = async <T extends Element>(
  finder: () => T | null,
  timeout = 5000,
  interval = 100
): Promise<T | null> => {
  const existing = finder()
  if (existing) return existing
  return new Promise((resolve) => {
    const start = Date.now()
    const timer = window.setInterval(() => {
      const element = finder()
      if (element) {
        window.clearInterval(timer)
        resolve(element)
        return
      }
      if (Date.now() - start > timeout) {
        window.clearInterval(timer)
        resolve(null)
      }
    }, interval)
  })
}

/** Extract a number from text (defaults to first integer). */
export const extractNumber = (text: string, pattern: RegExp = /(\d[\d,.]*)/): number | null => {
  const match = text.match(pattern)
  const raw = match?.[1]
  if (!raw) return null
  const value = Number.parseInt(raw.replace(/[,.]/g, ""), 10)
  return Number.isNaN(value) ? null : value
}

/** Type text into an input character-by-character with human-like delays. */
export const typeTextLikeHuman = async (
  input: HTMLInputElement,
  text: string
) => {
  input.focus()
  input.value = ""
  input.dispatchEvent(new Event("input", { bubbles: true }))
  for (const character of text) {
    input.value = `${input.value}${character}`
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await humanKeyDelay()
  }
  input.dispatchEvent(new Event("change", { bubbles: true }))
}
