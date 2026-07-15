import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs"
import { basename, join } from "node:path"
import { parse as parseYaml } from "yaml"
import {
  automationDir,
  automationsDir,
  runCancelPath,
  runPath,
  runsDir,
} from "./paths.js"
import type { Recipe, RunState } from "./types.js"
import { assertAutomationName, validateRecipe } from "./validate.js"

export function ensureDirs(): void {
  mkdirSync(automationsDir(), { recursive: true })
  mkdirSync(runsDir(), { recursive: true })
}

export interface AutomationInfo {
  name: string
  description?: string
  path: string
  recipeFile: string
}

function recipeFiles(dir: string): { file: string; kind: "yaml" | "json" } | null {
  const yaml = join(dir, "recipe.yaml")
  const yml = join(dir, "recipe.yml")
  const json = join(dir, "recipe.json")
  if (existsSync(yaml)) return { file: yaml, kind: "yaml" }
  if (existsSync(yml)) return { file: yml, kind: "yaml" }
  if (existsSync(json)) return { file: json, kind: "json" }
  return null
}

export function listAutomations(): AutomationInfo[] {
  ensureDirs()
  const root = automationsDir()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const path = join(root, d.name)
      const rf = recipeFiles(path)
      if (!rf) return null
      try {
        const recipe = loadRecipeFromFile(rf.file, rf.kind)
        return {
          name: d.name,
          description: recipe.description,
          path,
          recipeFile: rf.file,
        }
      } catch {
        return { name: d.name, path, recipeFile: rf.file }
      }
    })
    .filter((x): x is AutomationInfo => x != null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function loadRecipeFromFile(file: string, kind: "yaml" | "json"): Recipe {
  const text = readFileSync(file, "utf8")
  const raw = kind === "yaml" ? parseYaml(text) : JSON.parse(text)
  const v = validateRecipe(raw)
  if (!v.ok) throw new Error(`Invalid recipe (${basename(file)}):\n  - ${v.errors.join("\n  - ")}`)
  return v.recipe
}

export function loadRecipe(name: string): { recipe: Recipe; dir: string; hooksPath: string | null } {
  const n = assertAutomationName(name)
  const dir = automationDir(n)
  const rf = recipeFiles(dir)
  if (!rf) throw new Error(`Automation "${n}" not found in ${dir}`)
  const recipe = loadRecipeFromFile(rf.file, rf.kind)
  const hooks = join(dir, "hooks.mjs")
  return { recipe, dir, hooksPath: existsSync(hooks) ? hooks : null }
}

export function saveAutomation(
  name: string,
  opts: { recipeFile: string; hooksFile?: string | null; force?: boolean; readme?: string | null }
): string {
  const n = assertAutomationName(name)
  ensureDirs()
  const dir = automationDir(n)
  if (existsSync(dir) && !opts.force) {
    throw new Error(`Automation "${n}" already exists. Pass --force to overwrite.`)
  }
  mkdirSync(dir, { recursive: true })

  const src = opts.recipeFile
  if (!existsSync(src)) throw new Error(`Recipe file not found: ${src}`)
  const lower = src.toLowerCase()
  const destName =
    lower.endsWith(".yaml") || lower.endsWith(".yml")
      ? "recipe.yaml"
      : lower.endsWith(".json")
        ? "recipe.json"
        : null
  if (!destName) throw new Error("Recipe file must be .json, .yaml, or .yml")

  // Validate before writing.
  const kind = destName.endsWith(".json") ? "json" : "yaml"
  const recipe = loadRecipeFromFile(src, kind)
  if (recipe.name && recipe.name !== n) {
    // Allow mismatch but warn via keeping folder name as source of truth.
  }

  // Clear alternate recipe format so only one is active.
  for (const f of ["recipe.json", "recipe.yaml", "recipe.yml"]) {
    const p = join(dir, f)
    if (existsSync(p)) rmSync(p)
  }
  copyFileSync(src, join(dir, destName))

  if (opts.hooksFile) {
    if (!existsSync(opts.hooksFile)) throw new Error(`Hooks file not found: ${opts.hooksFile}`)
    copyFileSync(opts.hooksFile, join(dir, "hooks.mjs"))
  }
  if (opts.readme) {
    writeFileSync(join(dir, "README.md"), opts.readme)
  }
  return dir
}

export function deleteAutomation(name: string): void {
  const n = assertAutomationName(name)
  const dir = automationDir(n)
  if (!existsSync(dir)) throw new Error(`Automation "${n}" not found`)
  rmSync(dir, { recursive: true, force: true })
}

export function writeRun(state: RunState): void {
  ensureDirs()
  writeFileSync(runPath(state.id), JSON.stringify(state, null, 2))
}

export function readRun(id: string): RunState {
  const p = runPath(id)
  if (!existsSync(p)) throw new Error(`Run "${id}" not found`)
  return JSON.parse(readFileSync(p, "utf8")) as RunState
}

export function listRuns(limit = 20): RunState[] {
  ensureDirs()
  const root = runsDir()
  return readdirSync(root)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(root, f), "utf8")) as RunState
      } catch {
        return null
      }
    })
    .filter((x): x is RunState => x != null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit)
}

export function requestCancel(id: string): void {
  ensureDirs()
  // Touch cancel flag; also flip status if file exists.
  writeFileSync(runCancelPath(id), "1")
  const p = runPath(id)
  if (existsSync(p)) {
    const state = readRun(id)
    if (state.status === "running") {
      state.log = [...state.log, "cancel requested"]
      writeRun(state)
    }
  }
}

export function isCancelRequested(id: string): boolean {
  return existsSync(runCancelPath(id))
}

export function clearCancel(id: string): void {
  const p = runCancelPath(id)
  if (existsSync(p)) rmSync(p)
}

export function newRunId(): string {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 8)
  return `run_${t}_${r}`
}
