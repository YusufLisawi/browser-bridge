import { pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import type { ActionStep, Job, JobResult, TabTarget } from "../../shared/protocol.js"
import type { Session } from "../server.js"
import { evalExpr, interpolate, truthy, type InterpContext } from "./interp.js"
import { clearCancel, isCancelRequested, writeRun } from "./store.js"
import type {
  BrowserStep,
  CallStep,
  GotoStep,
  LogStep,
  OnFail,
  Recipe,
  RecipeStep,
  RetryPolicy,
  RunState,
  SetStep,
} from "./types.js"
import { isForeachStep, isWhenStep } from "./types.js"

export type SendFn = (job: Job, timeoutMs?: number) => Promise<JobResult>

export interface EngineOptions {
  recipe: Recipe
  run: RunState
  input: Record<string, unknown>
  tab: TabTarget
  hooksPath: string | null
  send: SendFn | null
  /** Max wall-clock ms for the whole run (default 30m). */
  runTimeoutMs?: number
  onProgress?: (line: string, state: RunState) => void
}

class GotoSignal extends Error {
  constructor(public targetId: string) {
    super(`goto:${targetId}`)
    this.name = "GotoSignal"
  }
}

class AbortRun extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AbortRun"
  }
}

class CancelledRun extends Error {
  constructor() {
    super("cancelled")
    this.name = "CancelledRun"
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function stepLabel(step: RecipeStep, fallback: string): string {
  if (step.id) return step.id
  if (isForeachStep(step)) return `foreach:${step.as}`
  if (isWhenStep(step)) return "when"
  if ("action" in step) return String(step.action)
  return fallback
}

function toActionStep(step: BrowserStep, defaults: Recipe["defaults"]): ActionStep {
  const human = step.human ?? defaults?.human
  const timeout = step.timeout ?? defaults?.timeout
  const base: ActionStep = {
    action: step.action as ActionStep["action"],
    target: step.target,
    text: step.text,
    value: step.value,
    key: step.key,
    url: step.url,
    timeout,
    code: step.code,
    arg: step.arg,
    as: step.as,
    deltaY: step.deltaY,
    human,
    steps: step.steps,
    x: step.x,
    y: step.y,
  }
  return base
}

function mergeInput(
  spec: Recipe["input"],
  provided: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (spec) {
    for (const [k, s] of Object.entries(spec)) {
      if (provided[k] !== undefined) out[k] = coerceInput(provided[k], s.type)
      else if (s.default !== undefined) out[k] = s.default
    }
  }
  for (const [k, v] of Object.entries(provided)) {
    if (out[k] === undefined) out[k] = v
  }
  return out
}

function coerceInput(v: unknown, type?: string): unknown {
  if (type === "number") return typeof v === "number" ? v : Number(v)
  if (type === "boolean") return v === true || v === "true" || v === "1"
  if (type === "json") return typeof v === "string" ? JSON.parse(v) : v
  return v
}

export async function runAutomation(opts: EngineOptions): Promise<RunState> {
  const { recipe } = opts
  const input = mergeInput(recipe.input, opts.input)
  const vars: Record<string, unknown> = { ...(recipe.vars ?? {}) }
  const run = opts.run
  run.input = input
  run.vars = vars
  run.status = "running"
  run.pid = process.pid
  writeRun(run)
  clearCancel(run.id)

  const started = Date.now()
  const runTimeoutMs = opts.runTimeoutMs ?? 30 * 60 * 1000

  const persist = (step?: string) => {
    run.vars = vars
    if (step) run.step = step
    writeRun(run)
  }

  const logLine = (msg: string) => {
    run.log.push(msg)
    if (run.log.length > 500) run.log = run.log.slice(-400)
    opts.onProgress?.(msg, run)
    persist()
  }

  const checkLimits = () => {
    if (isCancelRequested(run.id)) throw new CancelledRun()
    if (Date.now() - started > runTimeoutMs) {
      throw new AbortRun(`Run timed out after ${runTimeoutMs}ms`)
    }
  }

  const aliases: Record<string, unknown> = {}

  const ctx = (): InterpContext => ({ vars, input, env: {}, ...aliases })

  type HookFn = (args: {
    arg: unknown
    vars: Record<string, unknown>
    input: Record<string, unknown>
  }) => unknown
  let hooks: Record<string, HookFn> | null = null
  if (opts.hooksPath) {
    const mod = (await import(pathToFileURL(opts.hooksPath).href)) as Record<string, unknown>
    hooks = {}
    for (const [k, v] of Object.entries(mod)) {
      if (typeof v === "function") hooks[k] = v as HookFn
    }
  }

  const defaultRetry: RetryPolicy = recipe.defaults?.retry ?? { times: 0, delayMs: 500 }
  const defaultOnFail: OnFail = recipe.defaults?.onFail ?? "abort"

  const runBrowserStep = async (step: BrowserStep, label: string): Promise<void> => {
    if (!opts.send) throw new AbortRun("Browser step requires an extension session (send).")
    const interpolated = interpolate({ ...step }, ctx()) as BrowserStep
    const retry = interpolated.retry ?? defaultRetry
    const onFail = interpolated.onFail ?? defaultOnFail
    const attempts = Math.max(0, retry.times) + 1
    let lastErr = ""

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      checkLimits()
      try {
        if (interpolated.action === "snapshot") {
          const result = await opts.send(
            { id: randomUUID(), kind: "snapshot", tab: opts.tab },
            (interpolated.timeout ?? recipe.defaults?.timeout ?? 15000) + 5000
          )
          if (!result.ok || result.kind !== "snapshot") {
            throw new Error(!result.ok ? result.error : "unexpected snapshot result")
          }
          if (interpolated.as) vars[interpolated.as] = result.elements
          logLine(`${label}: snapshot ${result.elements.length} elements`)
          return
        }

        // Prefer standalone eval job for clearer return values.
        if (interpolated.action === "eval") {
          const result = await opts.send(
            {
              id: randomUUID(),
              kind: "eval",
              code: interpolated.code ?? "",
              tab: opts.tab,
              arg: interpolated.arg,
              timeout: interpolated.timeout ?? recipe.defaults?.timeout,
            },
            (interpolated.timeout ?? recipe.defaults?.timeout ?? 15000) + 5000
          )
          if (!result.ok || result.kind !== "eval") {
            throw new Error(!result.ok ? result.error : "unexpected eval result")
          }
          if (interpolated.as) vars[interpolated.as] = result.value
          logLine(`${label}: eval ok`)
          return
        }

        const action = toActionStep(interpolated, recipe.defaults)
        const result = await opts.send(
          {
            id: randomUUID(),
            kind: "act",
            actions: [action],
            tab: opts.tab,
            snapshot: recipe.defaults?.noSnapshot === false,
            continueOnError: false,
          },
          (action.timeout ?? 15000) + 10000
        )
        if (!result.ok) throw new Error(result.error)
        if (result.kind !== "act") throw new Error("unexpected act result")
        const stepRes = result.results[0]
        if (!stepRes?.ok) throw new Error(stepRes?.error || "action failed")
        if (interpolated.as) {
          vars[interpolated.as] = stepRes.json !== undefined ? stepRes.json : stepRes.value
        }
        if (result.snapshot) vars.lastSnapshot = result.snapshot
        logLine(`${label}: ${interpolated.action}${interpolated.target ? " " + interpolated.target : ""} ok`)
        return
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err)
        if (attempt < attempts) {
          logLine(`${label}: retry ${attempt}/${attempts - 1} after ${lastErr}`)
          await sleep(retry.delayMs ?? 500)
          continue
        }
      }
    }

    await handleFail(onFail, label, lastErr)
  }

  const handleFail = async (onFail: OnFail, label: string, err: string) => {
    logLine(`${label}: failed — ${err}`)
    if (onFail === "continue") {
      const failed = Array.isArray(vars.failed) ? (vars.failed as unknown[]) : []
      failed.push({ step: label, error: err })
      vars.failed = failed
      return
    }
    if (typeof onFail === "string" && onFail.startsWith("goto:")) {
      throw new GotoSignal(onFail.slice(5))
    }
    throw new AbortRun(`${label}: ${err}`)
  }

  const runSet = (step: SetStep, label: string) => {
    const s = interpolate({ ...step }, ctx()) as SetStep
    let value: unknown
    if (s.expr != null) value = evalExpr(s.expr, ctx())
    else value = s.value
    vars[s.var] = value
    logLine(`${label}: set ${s.var}=${JSON.stringify(value)}`)
  }

  const runLog = (step: LogStep, label: string) => {
    const s = interpolate({ ...step }, ctx()) as LogStep
    logLine(`${label}: ${s.message}`)
  }

  const runCall = async (step: CallStep, label: string) => {
    if (!hooks) throw new AbortRun(`${label}: no hooks.mjs loaded`)
    const s = interpolate({ ...step }, ctx()) as CallStep
    const fn = hooks[s.hook]
    if (typeof fn !== "function") throw new AbortRun(`${label}: hook "${s.hook}" not found`)
    const value = await Promise.resolve(fn({ arg: s.arg, vars, input }))
    if (s.as) vars[s.as] = value
    logLine(`${label}: call ${s.hook} ok`)
  }

  const runSteps = async (steps: RecipeStep[], path: string): Promise<void> => {
    let i = 0
    while (i < steps.length) {
      checkLimits()
      const step = steps[i]
      const label = `${path}/${stepLabel(step, String(i))}`
      run.step = label
      persist(label)

      try {
        if (isForeachStep(step)) {
          const pathOnly = step.foreach.replace(/^\$\{|\}$/g, "")
          const items = interpolate(`\${${pathOnly}}`, ctx())

          if (!Array.isArray(items)) {
            throw new AbortRun(`${label}: foreach expected an array, got ${typeof items}`)
          }
          run.progress = { iteration: 0, total: items.length }
          for (let j = 0; j < items.length; j += 1) {
            checkLimits()
            run.progress = { iteration: j + 1, total: items.length }
            vars[step.as] = items[j]
            aliases[step.as] = items[j]
            logLine(`${label}: item ${j + 1}/${items.length}`)
            await runSteps(step.steps, `${label}[${j}]`)
          }
          delete vars[step.as]
          delete aliases[step.as]
          i += 1
          continue
        }

        if (isWhenStep(step)) {
          const cond = evalExpr(step.when.replace(/^\$\{|\}$/g, ""), ctx())
          if (truthy(cond)) await runSteps(step.steps, `${label}/then`)
          else if (step.else) await runSteps(step.else, `${label}/else`)
          i += 1
          continue
        }

        if (!("action" in step)) {
          throw new AbortRun(`${label}: invalid step`)
        }

        const action = step.action
        if (action === "set") {
          runSet(step as SetStep, label)
        } else if (action === "log") {
          runLog(step as LogStep, label)
        } else if (action === "call") {
          const retry = step.retry ?? defaultRetry
          const onFail = step.onFail ?? defaultOnFail
          const attempts = Math.max(0, retry.times) + 1
          let lastErr = ""
          let ok = false
          for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
              await runCall(step as CallStep, label)
              ok = true
              break
            } catch (err) {
              lastErr = err instanceof Error ? err.message : String(err)
              if (attempt < attempts) await sleep(retry.delayMs ?? 500)
            }
          }
          if (!ok) await handleFail(onFail, label, lastErr)
        } else if (action === "goto") {
          const s = interpolate({ ...step }, ctx()) as GotoStep
          throw new GotoSignal(s.target)
        } else {
          await runBrowserStep(step as BrowserStep, label)
        }
        i += 1
      } catch (err) {
        if (err instanceof GotoSignal) {
          const idx = steps.findIndex((s) => s.id === err.targetId)
          if (idx < 0) throw new AbortRun(`${label}: goto target "${err.targetId}" not found in this block`)
          i = idx
          continue
        }
        throw err
      }
    }
  }

  try {
    await runSteps(recipe.steps, recipe.name)
    run.status = "done"
    run.finishedAt = new Date().toISOString()
    run.step = null
    if (recipe.onComplete?.summary) {
      run.summary = String(interpolate(recipe.onComplete.summary, ctx()))
    } else {
      run.summary = `Automation "${recipe.name}" completed`
    }
    logLine(`✓ ${run.summary}`)
    persist()
    return run
  } catch (err) {
    if (err instanceof CancelledRun) {
      run.status = "cancelled"
      run.error = "cancelled"
      run.summary = "Cancelled"
      run.finishedAt = new Date().toISOString()
      logLine("✗ cancelled")
      persist()
      return run
    }
    const msg = err instanceof Error ? err.message : String(err)
    run.status = "failed"
    run.error = msg
    run.summary = msg
    run.finishedAt = new Date().toISOString()
    logLine(`✗ ${msg}`)
    persist()
    return run
  }
}

/** Build a SendFn from a live Session. */
export function sessionSend(session: Session): SendFn {
  return (job, timeoutMs) => session.send(job, timeoutMs)
}
