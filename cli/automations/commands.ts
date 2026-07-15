import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { createSession } from "../server.js"
import { runAutomation, sessionSend } from "./engine.js"
import {
  clearCancel,
  deleteAutomation,
  listAutomations,
  listRuns,
  loadRecipe,
  newRunId,
  readRun,
  requestCancel,
  saveAutomation,
  writeRun,
} from "./store.js"
import { syncAllAutomationsToExtension, syncAutomationToExtension, unsyncAutomationFromExtension } from "./sync.js"
import type { RunState } from "./types.js"

const log = (s = "") => process.stdout.write(s + "\n")

export interface AutoFlags {
  json: boolean
  file: string | null
  hooks: string | null
  force: boolean
  detach: boolean
  wait: boolean
  tab: string | null
  timeout: number | null
  vars: Record<string, string>
  limit: number
  worker: boolean
  runId: string | null
  positional: string[]
}

export function parseAutoFlags(args: string[]): AutoFlags {
  const flags: AutoFlags = {
    json: false,
    file: null,
    hooks: null,
    force: false,
    detach: false,
    wait: true,
    tab: null,
    timeout: null,
    vars: {},
    limit: 20,
    worker: false,
    runId: null,
    positional: [],
  }
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === "--json") flags.json = true
    else if (a === "--file") flags.file = args[++i] ?? null
    else if (a === "--hooks") flags.hooks = args[++i] ?? null
    else if (a === "--force") flags.force = true
    else if (a === "--detach") {
      flags.detach = true
      flags.wait = false
    } else if (a === "--wait") {
      flags.wait = true
      flags.detach = false
    } else if (a === "--tab") flags.tab = args[++i] ?? null
    else if (a === "--timeout") flags.timeout = parseInt(args[++i] ?? "", 10) || null
    else if (a === "--limit") flags.limit = Math.max(1, parseInt(args[++i] ?? "20", 10) || 20)
    else if (a === "--var") {
      const raw = args[++i] ?? ""
      const eq = raw.indexOf("=")
      if (eq < 1) throw new Error(`--var expects key=value, got "${raw}"`)
      flags.vars[raw.slice(0, eq)] = raw.slice(eq + 1)
    } else if (a === "--_worker") flags.worker = true
    else if (a === "--run-id") flags.runId = args[++i] ?? null
    else flags.positional.push(a)
  }
  return flags
}

function parseVarValue(v: string): unknown {
  if (v === "true") return true
  if (v === "false") return false
  if (v === "null") return null
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  if ((v.startsWith("{") && v.endsWith("}")) || (v.startsWith("[") && v.endsWith("]"))) {
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  }
  return v
}

function printHelp() {
  log(`bridge automation — reusable recipes for repetitive browser tasks

Usage:
  bridge automation list
  bridge automation show <name>
  bridge automation save <name> --file recipe.yaml [--hooks hooks.mjs] [--force]
  bridge automation delete <name>

  bridge automation run <name> [--var k=v]… [--tab active|bridge|id] [--wait|--detach] [--timeout ms]
  bridge automation status [runId] [--json]
  bridge automation wait <runId> [--json]
  bridge automation cancel <runId>
  bridge automation runs [--limit N]
  bridge automation sync                       Push all recipes into the extension popup

Recipes live in ~/.browser-bridge/automations/<name>/
Run state lives in ~/.browser-bridge/runs/
Popup lists synced automations by site — click Run to replay without the agent.

Alias: bridge auto …`)
}

async function cmdList(flags: AutoFlags) {
  const list = listAutomations()
  if (flags.json) {
    log(JSON.stringify(list, null, 2))
    return
  }
  if (!list.length) {
    log("No automations yet. Save one with: bridge auto save <name> --file recipe.json")
    return
  }
  for (const a of list) {
    log(`${a.name}${a.description ? " — " + a.description : ""}`)
  }
}

async function cmdShow(flags: AutoFlags) {
  const name = flags.positional[0]
  if (!name) throw new Error("Usage: bridge automation show <name>")
  const { recipe, dir, hooksPath } = loadRecipe(name)
  if (flags.json) {
    log(JSON.stringify({ dir, hooksPath, recipe }, null, 2))
    return
  }
  log(`# ${recipe.name}`)
  if (recipe.description) log(recipe.description)
  log(`path: ${dir}`)
  if (hooksPath) log(`hooks: ${hooksPath}`)
  log(`steps: ${recipe.steps.length}`)
  log()
  log(JSON.stringify(recipe, null, 2))
}

async function cmdSave(flags: AutoFlags) {
  const name = flags.positional[0]
  if (!name || !flags.file) throw new Error("Usage: bridge automation save <name> --file recipe.yaml [--hooks h.mjs] [--force]")
  const dir = saveAutomation(name, {
    recipeFile: flags.file,
    hooksFile: flags.hooks,
    force: flags.force,
  })
  log(`✓ Saved automation "${name}" → ${dir}`)
  try {
    await syncAutomationToExtension(name)
    log(`✓ Synced to extension popup`)
  } catch (err) {
    log(`⚠ Saved locally but could not sync to extension: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function cmdDelete(flags: AutoFlags) {
  const name = flags.positional[0]
  if (!name) throw new Error("Usage: bridge automation delete <name>")
  deleteAutomation(name)
  log(`✓ Deleted automation "${name}"`)
  try {
    await unsyncAutomationFromExtension(name)
    log(`✓ Removed from extension popup`)
  } catch (err) {
    log(`⚠ Deleted locally but could not update extension: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function cmdSync(_flags: AutoFlags) {
  const n = await syncAllAutomationsToExtension()
  log(`✓ Synced ${n} automation${n === 1 ? "" : "s"} to the extension popup`)
}

function needsBrowser(recipe: { steps: unknown[] }): boolean {
  const walk = (steps: unknown[]): boolean => {
    for (const raw of steps) {
      if (!raw || typeof raw !== "object") continue
      const s = raw as Record<string, unknown>
      if (Array.isArray(s.steps) && walk(s.steps)) return true
      if (Array.isArray(s.else) && walk(s.else)) return true
      const action = s.action
      if (typeof action === "string" && !["set", "log", "call", "goto"].includes(action)) return true
    }
    return false
  }
  return walk(recipe.steps)
}

async function executeRun(name: string, flags: AutoFlags, runId: string): Promise<RunState> {
  const { recipe, hooksPath } = loadRecipe(name)
  const input: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(flags.vars)) input[k] = parseVarValue(v)

  const run: RunState = {
    id: runId,
    automation: name,
    status: "running",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    step: null,
    vars: {},
    input,
    log: [],
    error: null,
    summary: null,
  }
  writeRun(run)

  const tab = flags.tab ?? recipe.tab ?? "active"
  const useBrowser = needsBrowser(recipe)
  let session: Awaited<ReturnType<typeof createSession>> | null = null

  try {
    if (useBrowser) {
      session = await createSession({
        onWaiting: () => process.stderr.write("Waiting for the extension to connect…\n"),
      })
    }

    return await runAutomation({
      recipe,
      run,
      input,
      tab,
      hooksPath,
      send: session ? sessionSend(session) : null,
      runTimeoutMs: flags.timeout ?? undefined,
      onProgress: (line) => {
        if (!flags.json) process.stderr.write(`  ${line}\n`)
      },
    })
  } finally {
    session?.close()
  }
}

function cliEntryPath(): string {
  // dist-cli/cli/index.js when built; fall back to this file's sibling index.
  const here = dirname(fileURLToPath(import.meta.url))
  // automations/ → cli/
  return join(here, "..", "index.js")
}

async function cmdRun(flags: AutoFlags) {
  const name = flags.positional[0]
  if (!name) throw new Error("Usage: bridge automation run <name> [--var k=v]… [--wait|--detach]")

  // Ensure recipe exists before detach.
  loadRecipe(name)

  if (flags.detach && !flags.worker) {
    const runId = newRunId()
    const entry = cliEntryPath()
    const args = [
      entry,
      "automation",
      "run",
      name,
      "--_worker",
      "--run-id",
      runId,
      "--wait",
    ]
    if (flags.tab) args.push("--tab", flags.tab)
    if (flags.timeout != null) args.push("--timeout", String(flags.timeout))
    if (flags.json) args.push("--json")
    for (const [k, v] of Object.entries(flags.vars)) args.push("--var", `${k}=${v}`)

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    })
    child.unref()

    // Seed a running stub so status works immediately.
    writeRun({
      id: runId,
      automation: name,
      status: "running",
      pid: child.pid,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      step: null,
      vars: {},
      input: Object.fromEntries(Object.entries(flags.vars).map(([k, v]) => [k, parseVarValue(v)])),
      log: ["detached worker started"],
      error: null,
      summary: null,
    })

    if (flags.json) log(JSON.stringify({ runId, status: "running", pid: child.pid }, null, 2))
    else log(`✓ Started "${name}" in background\n  runId: ${runId}\n  bridge auto status ${runId}`)
    return
  }

  const runId = flags.runId || newRunId()
  const result = await executeRun(name, flags, runId)
  if (flags.json) {
    log(JSON.stringify(result, null, 2))
  } else {
    log()
    if (result.status === "done") log(`✓ ${result.summary}`)
    else if (result.status === "cancelled") log(`✗ Cancelled (${result.id})`)
    else log(`✗ ${result.error || result.summary}`)
    log(`  runId: ${result.id}`)
  }
  process.exit(result.status === "done" ? 0 : 1)
}

async function cmdStatus(flags: AutoFlags) {
  const id = flags.positional[0]
  const state = id ? readRun(id) : listRuns(1)[0]
  if (!state) throw new Error(id ? `Run "${id}" not found` : "No runs yet")
  if (flags.json) log(JSON.stringify(state, null, 2))
  else {
    log(`${state.status}  ${state.automation}  (${state.id})`)
    if (state.step) log(`  step: ${state.step}`)
    if (state.progress) log(`  progress: ${state.progress.iteration}/${state.progress.total}`)
    if (state.summary) log(`  ${state.summary}`)
    if (state.error) log(`  error: ${state.error}`)
    const tail = state.log.slice(-5)
    if (tail.length) {
      log("  recent:")
      for (const l of tail) log(`    ${l}`)
    }
  }
  if (state.status === "running") process.exitCode = 0
  else process.exitCode = state.status === "done" ? 0 : 1
}

async function cmdWait(flags: AutoFlags) {
  const id = flags.positional[0]
  if (!id) throw new Error("Usage: bridge automation wait <runId>")
  const pollMs = 500
  for (;;) {
    const state = readRun(id)
    if (state.status !== "running") {
      if (flags.json) log(JSON.stringify(state, null, 2))
      else {
        log(`${state.status}: ${state.summary || state.error || ""}`)
      }
      process.exit(state.status === "done" ? 0 : 1)
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

async function cmdCancel(flags: AutoFlags) {
  const id = flags.positional[0]
  if (!id) throw new Error("Usage: bridge automation cancel <runId>")
  requestCancel(id)
  log(`✓ Cancel requested for ${id}`)
}

async function cmdRuns(flags: AutoFlags) {
  const runs = listRuns(flags.limit)
  if (flags.json) {
    log(JSON.stringify(runs, null, 2))
    return
  }
  if (!runs.length) {
    log("No runs yet.")
    return
  }
  for (const r of runs) {
    log(`${r.startedAt}  ${r.status.padEnd(10)}  ${r.automation}  ${r.id}`)
  }
}

export async function handleAutomation(args: string[]): Promise<void> {
  const flags = parseAutoFlags(args)
  const sub = flags.positional.shift()

  if (!sub || sub === "help" || sub === "--help") {
    printHelp()
    return
  }

  if (sub === "list") await cmdList(flags)
  else if (sub === "show") await cmdShow(flags)
  else if (sub === "save") await cmdSave(flags)
  else if (sub === "delete") await cmdDelete(flags)
  else if (sub === "sync") await cmdSync(flags)
  else if (sub === "run") await cmdRun(flags)
  else if (sub === "status") await cmdStatus(flags)
  else if (sub === "wait") await cmdWait(flags)
  else if (sub === "cancel") await cmdCancel(flags)
  else if (sub === "runs") await cmdRuns(flags)
  else throw new Error(`Unknown automation command "${sub}". Run 'bridge automation help'.`)
}

/** Test helper — expose recipe file read without save. */
export function readText(path: string): string {
  return readFileSync(path, "utf8")
}
