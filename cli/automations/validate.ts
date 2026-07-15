import type { Recipe, RecipeStep } from "./types.js"
import { isForeachStep, isWhenStep } from "./types.js"

const BROWSER_ACTIONS = new Set([
  "click",
  "fill",
  "type",
  "setValue",
  "select",
  "check",
  "uncheck",
  "press",
  "hover",
  "focus",
  "scrollIntoView",
  "scroll",
  "mouseMove",
  "waitFor",
  "waitForUrl",
  "submit",
  "getText",
  "getValue",
  "eval",
  "navigate",
  "snapshot",
  "set",
  "log",
  "call",
  "goto",
])

function validateSteps(steps: unknown, path: string): string[] {
  const errors: string[] = []
  if (!Array.isArray(steps)) {
    errors.push(`${path}: expected an array of steps`)
    return errors
  }
  steps.forEach((raw, i) => {
    const p = `${path}[${i}]`
    if (!raw || typeof raw !== "object") {
      errors.push(`${p}: step must be an object`)
      return
    }
    const s = raw as RecipeStep
    if (isForeachStep(s)) {
      if (!s.as) errors.push(`${p}: foreach requires "as"`)
      if (!Array.isArray(s.steps)) errors.push(`${p}: foreach requires "steps"`)
      else errors.push(...validateSteps(s.steps, `${p}.steps`))
      return
    }
    if (isWhenStep(s)) {
      if (!Array.isArray(s.steps)) errors.push(`${p}: when requires "steps"`)
      else errors.push(...validateSteps(s.steps, `${p}.steps`))
      if (s.else) errors.push(...validateSteps(s.else, `${p}.else`))
      return
    }
    if (!("action" in s) || typeof (s as { action?: unknown }).action !== "string") {
      errors.push(`${p}: missing action / foreach / when`)
      return
    }
    const action = (s as { action: string }).action
    if (!BROWSER_ACTIONS.has(action)) {
      errors.push(`${p}: unknown action "${action}"`)
    }
    if (action === "set" && !(s as { var?: string }).var) {
      errors.push(`${p}: set requires "var"`)
    }
    if (action === "log" && typeof (s as { message?: unknown }).message !== "string") {
      errors.push(`${p}: log requires "message"`)
    }
    if (action === "call" && !(s as { hook?: string }).hook) {
      errors.push(`${p}: call requires "hook"`)
    }
    if (action === "goto" && !(s as { target?: string }).target) {
      errors.push(`${p}: goto requires "target"`)
    }
    if (action === "eval" && !(s as { code?: string }).code) {
      errors.push(`${p}: eval requires "code"`)
    }
  })
  return errors
}

export function validateRecipe(raw: unknown): { ok: true; recipe: Recipe } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["recipe must be an object"] }
  }
  const r = raw as Partial<Recipe>
  if (!r.name || typeof r.name !== "string") errors.push('missing "name"')
  if (!Array.isArray(r.steps)) errors.push('missing "steps" array')
  else errors.push(...validateSteps(r.steps, "steps"))

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    recipe: {
      name: r.name!,
      description: r.description,
      version: r.version ?? 1,
      tab: r.tab,
      sites: r.sites,
      vars: r.vars ?? {},
      input: r.input,
      defaults: r.defaults,
      steps: r.steps as RecipeStep[],
      onComplete: r.onComplete,
    },
  }
}

/** Automation folder names: lowercase, digits, hyphen. */
export function assertAutomationName(name: string): string {
  const n = name.trim()
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(n)) {
    throw new Error(
      `Invalid automation name "${name}". Use letters, digits, hyphen, underscore (max 64).`
    )
  }
  return n
}
