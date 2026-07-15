/**
 * In-extension recipe runner for one-click popup replay.
 * Mirrors the CLI engine for browser/control steps; `call` (hooks.mjs) is unsupported.
 */

import { evalExpr, interpolate, truthy, type InterpContext } from "../../shared/interp"

export type OnFail = "abort" | "continue" | `goto:${string}`

export interface RecipeLike {
  name: string
  description?: string
  tab?: string
  sites?: string[]
  vars?: Record<string, unknown>
  input?: Record<string, { type?: string; default?: unknown }>
  defaults?: {
    timeout?: number
    human?: boolean
    retry?: { times: number; delayMs?: number }
    onFail?: OnFail
    noSnapshot?: boolean
  }
  steps: StepLike[]
  onComplete?: { summary?: string }
}

export type StepLike = Record<string, unknown> & {
  id?: string
  action?: string
  foreach?: string
  when?: string
  as?: string
  steps?: StepLike[]
  else?: StepLike[]
  retry?: { times: number; delayMs?: number }
  onFail?: OnFail
}

export interface AutoBrowserApi {
  act(actions: Record<string, unknown>[], tab?: string, withSnapshot?: boolean): Promise<{
    url: string
    results: { ok: boolean; error?: string; value?: string; json?: unknown }[]
    snapshot?: unknown
  }>
  eval(code: string, arg: unknown, timeout: number | undefined, tab?: string): Promise<{ url: string; value: unknown }>
  snapshot(tab?: string): Promise<{ url: string; title: string; elements: unknown[] }>
}

export interface AutoRunProgress {
  status: "running" | "done" | "failed" | "cancelled"
  name: string
  step?: string
  log: string[]
  error?: string
  summary?: string
  vars?: Record<string, unknown>
}

class GotoSignal extends Error {
  constructor(public targetId: string) {
    super(`goto:${targetId}`)
  }
}
class AbortRun extends Error {}
class CancelledRun extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function stepLabel(step: StepLike, fallback: string): string {
  if (step.id) return step.id
  if (step.foreach) return `foreach:${step.as || "item"}`
  if (step.when) return "when"
  if (step.action) return String(step.action)
  return fallback
}

function mergeInput(
  spec: RecipeLike["input"],
  provided: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...provided }
  if (spec) {
    for (const [k, s] of Object.entries(spec)) {
      if (out[k] === undefined && s.default !== undefined) out[k] = s.default
    }
  }
  return out
}

export async function runRecipeInExtension(opts: {
  recipe: RecipeLike
  input?: Record<string, unknown>
  tab?: string
  api: AutoBrowserApi
  isCancelled?: () => boolean | Promise<boolean>
  onProgress?: (p: AutoRunProgress) => void
}): Promise<AutoRunProgress> {
  const recipe = opts.recipe
  const input = mergeInput(recipe.input, opts.input ?? {})
  const vars: Record<string, unknown> = { ...(recipe.vars ?? {}) }
  const aliases: Record<string, unknown> = {}
  const tab = opts.tab ?? recipe.tab ?? "active"
  const log: string[] = []
  const progress: AutoRunProgress = {
    status: "running",
    name: recipe.name,
    log,
    vars,
  }

  const emit = (step?: string) => {
    progress.step = step
    progress.vars = { ...vars }
    opts.onProgress?.({ ...progress, log: [...log] })
  }

  const logLine = (msg: string) => {
    log.push(msg)
    if (log.length > 200) log.splice(0, log.length - 150)
    emit(progress.step)
  }

  const ctx = (): InterpContext => ({ vars, input, env: {}, ...aliases })

  const check = async () => {
    if (await opts.isCancelled?.()) throw new CancelledRun()
  }

  const defaultRetry = recipe.defaults?.retry ?? { times: 0, delayMs: 500 }
  const defaultOnFail: OnFail = recipe.defaults?.onFail ?? "abort"

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

  const runBrowser = async (step: StepLike, label: string) => {
    const interpolated = interpolate({ ...step }, ctx()) as StepLike
    const retry = interpolated.retry ?? defaultRetry
    const onFail = (interpolated.onFail as OnFail) ?? defaultOnFail
    const attempts = Math.max(0, retry.times) + 1
    let lastErr = ""

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await check()
      try {
        const action = String(interpolated.action)
        if (action === "snapshot") {
          const r = await opts.api.snapshot(tab)
          if (interpolated.as) vars[String(interpolated.as)] = r.elements
          logLine(`${label}: snapshot ${r.elements.length} elements`)
          return
        }
        if (action === "eval") {
          const r = await opts.api.eval(
            String(interpolated.code ?? ""),
            interpolated.arg,
            typeof interpolated.timeout === "number" ? interpolated.timeout : recipe.defaults?.timeout,
            tab
          )
          if (interpolated.as) vars[String(interpolated.as)] = r.value
          logLine(`${label}: eval ok`)
          return
        }
        const actStep: Record<string, unknown> = {
          action,
          target: interpolated.target,
          text: interpolated.text,
          value: interpolated.value,
          key: interpolated.key,
          url: interpolated.url,
          timeout: interpolated.timeout ?? recipe.defaults?.timeout,
          code: interpolated.code,
          arg: interpolated.arg,
          as: interpolated.as,
          deltaY: interpolated.deltaY,
          human: interpolated.human ?? recipe.defaults?.human,
          steps: interpolated.steps,
          x: interpolated.x,
          y: interpolated.y,
        }
        const r = await opts.api.act([actStep], tab, recipe.defaults?.noSnapshot === false)
        const stepRes = r.results[0]
        if (!stepRes?.ok) throw new Error(stepRes?.error || "action failed")
        if (interpolated.as) {
          vars[String(interpolated.as)] = stepRes.json !== undefined ? stepRes.json : stepRes.value
        }
        if (r.snapshot) vars.lastSnapshot = r.snapshot
        logLine(`${label}: ${action}${interpolated.target ? " " + interpolated.target : ""} ok`)
        return
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err)
        if (attempt < attempts) {
          logLine(`${label}: retry ${attempt}/${attempts - 1}`)
          await sleep(retry.delayMs ?? 500)
          continue
        }
      }
    }
    await handleFail(onFail, label, lastErr)
  }

  const runSteps = async (steps: StepLike[], path: string): Promise<void> => {
    let i = 0
    while (i < steps.length) {
      await check()
      const step = steps[i]
      const label = `${path}/${stepLabel(step, String(i))}`
      emit(label)

      try {
        if (typeof step.foreach === "string") {
          const pathOnly = step.foreach.replace(/^\$\{|\}$/g, "")
          const items = interpolate(`\${${pathOnly}}`, ctx())
          if (!Array.isArray(items)) throw new AbortRun(`${label}: foreach expected an array`)
          for (let j = 0; j < items.length; j += 1) {
            await check()
            vars[String(step.as)] = items[j]
            aliases[String(step.as)] = items[j]
            logLine(`${label}: item ${j + 1}/${items.length}`)
            await runSteps(step.steps || [], `${label}[${j}]`)
          }
          delete vars[String(step.as)]
          delete aliases[String(step.as)]
          i += 1
          continue
        }

        if (typeof step.when === "string") {
          const cond = evalExpr(step.when.replace(/^\$\{|\}$/g, ""), ctx())
          if (truthy(cond)) await runSteps(step.steps || [], `${label}/then`)
          else if (step.else) await runSteps(step.else, `${label}/else`)
          i += 1
          continue
        }

        const action = step.action
        if (action === "set") {
          const s = interpolate({ ...step }, ctx()) as StepLike
          const value = s.expr != null ? evalExpr(String(s.expr), ctx()) : s.value
          vars[String(s.var)] = value
          logLine(`${label}: set ${s.var}=${JSON.stringify(value)}`)
        } else if (action === "log") {
          const s = interpolate({ ...step }, ctx()) as StepLike
          logLine(`${label}: ${s.message}`)
        } else if (action === "call") {
          throw new AbortRun(`${label}: hooks (call) are not supported from the popup — use the CLI`)
        } else if (action === "goto") {
          const s = interpolate({ ...step }, ctx()) as StepLike
          throw new GotoSignal(String(s.target))
        } else if (action) {
          await runBrowser(step, label)
        } else {
          throw new AbortRun(`${label}: invalid step`)
        }
        i += 1
      } catch (err) {
        if (err instanceof GotoSignal) {
          const idx = steps.findIndex((s) => s.id === err.targetId)
          if (idx < 0) throw new AbortRun(`${label}: goto "${err.targetId}" not found`)
          i = idx
          continue
        }
        throw err
      }
    }
  }

  try {
    await runSteps(recipe.steps, recipe.name)
    progress.status = "done"
    progress.summary =
      recipe.onComplete?.summary != null
        ? String(interpolate(recipe.onComplete.summary, ctx()))
        : `Automation "${recipe.name}" completed`
    logLine(`✓ ${progress.summary}`)
    emit()
    return progress
  } catch (err) {
    if (err instanceof CancelledRun) {
      progress.status = "cancelled"
      progress.error = "cancelled"
      progress.summary = "Cancelled"
      logLine("✗ cancelled")
      emit()
      return progress
    }
    const msg = err instanceof Error ? err.message : String(err)
    progress.status = "failed"
    progress.error = msg
    progress.summary = msg
    logLine(`✗ ${msg}`)
    emit()
    return progress
  }
}
