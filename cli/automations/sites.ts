import type { InputSpec, Recipe, RecipeStep } from "./types.js"
import { isForeachStep, isWhenStep } from "./types.js"

/** Pull hostname from a URL-ish string. */
export function hostFromUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    return u.hostname || null
  } catch {
    return null
  }
}

function walkSteps(steps: RecipeStep[], visit: (s: RecipeStep) => void): void {
  for (const s of steps) {
    visit(s)
    if (isForeachStep(s)) walkSteps(s.steps, visit)
    if (isWhenStep(s)) {
      walkSteps(s.steps, visit)
      if (s.else) walkSteps(s.else, visit)
    }
  }
}

/**
 * Resolve sites for popup grouping: explicit `recipe.sites`, else infer from
 * navigate URLs and string input defaults that look like URLs.
 */
export function resolveSites(recipe: Recipe): string[] {
  if (recipe.sites?.length) {
    return [...new Set(recipe.sites.map((s) => s.trim().toLowerCase()).filter(Boolean))]
  }
  const hosts = new Set<string>()
  if (recipe.input) {
    for (const spec of Object.values(recipe.input) as InputSpec[]) {
      if (typeof spec.default === "string") {
        const h = hostFromUrl(spec.default)
        if (h) hosts.add(h.toLowerCase())
      }
    }
  }
  walkSteps(recipe.steps, (s) => {
    if ("action" in s && s.action === "navigate" && typeof s.url === "string") {
      if (s.url.includes("${")) {
        const m = s.url.match(/https?:\/\/([^/`"'${]+)/i)
        if (m?.[1]) hosts.add(m[1].toLowerCase())
        return
      }
      const h = hostFromUrl(s.url)
      if (h) hosts.add(h.toLowerCase())
    }
  })
  return [...hosts]
}
