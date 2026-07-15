import type { ActionStep, TabTarget } from "../../shared/protocol.js"

export type OnFail = "abort" | "continue" | `goto:${string}`

export interface RetryPolicy {
  times: number
  delayMs?: number
}

export interface InputSpec {
  type?: "string" | "number" | "boolean" | "json"
  default?: unknown
  description?: string
}

export interface RecipeDefaults {
  timeout?: number
  human?: boolean
  retry?: RetryPolicy
  onFail?: OnFail
  /** Skip after-action snapshot on act jobs (default true for speed). */
  noSnapshot?: boolean
}

/** Shared policy fields on any step. */
export interface StepPolicy {
  id?: string
  retry?: RetryPolicy
  onFail?: OnFail
  timeout?: number
  human?: boolean
}

/** Browser action step — same verbs as ActJob, plus optional snapshot. */
export interface BrowserStep extends StepPolicy {
  action: ActionStep["action"] | "snapshot"
  target?: string
  text?: string
  value?: string
  key?: string
  url?: string
  code?: string
  arg?: unknown
  as?: string
  deltaY?: number
  steps?: number
  x?: number
  y?: number
}

export interface SetStep extends StepPolicy {
  action: "set"
  var: string
  value?: unknown
  expr?: string
}

export interface LogStep extends StepPolicy {
  action: "log"
  message: string
}

export interface CallStep extends StepPolicy {
  action: "call"
  hook: string
  arg?: unknown
  as?: string
}

export interface GotoStep extends StepPolicy {
  action: "goto"
  target: string
}

export interface ForeachStep extends StepPolicy {
  foreach: string
  as: string
  steps: RecipeStep[]
}

export interface WhenStep extends StepPolicy {
  when: string
  steps: RecipeStep[]
  else?: RecipeStep[]
}

export type RecipeStep = BrowserStep | SetStep | LogStep | CallStep | GotoStep | ForeachStep | WhenStep

export interface Recipe {
  name: string
  description?: string
  version?: number
  tab?: TabTarget
  /** Hostnames this automation belongs to (popup groups by these). */
  sites?: string[]
  vars?: Record<string, unknown>
  input?: Record<string, InputSpec>
  defaults?: RecipeDefaults
  steps: RecipeStep[]
  onComplete?: {
    summary?: string
  }
}

export type RunStatus = "running" | "done" | "failed" | "cancelled"

export interface RunState {
  id: string
  automation: string
  status: RunStatus
  pid?: number
  startedAt: string
  finishedAt: string | null
  step: string | null
  progress?: { iteration?: number; total?: number }
  vars: Record<string, unknown>
  input: Record<string, unknown>
  log: string[]
  error: string | null
  summary: string | null
}

export function isForeachStep(s: RecipeStep): s is ForeachStep {
  return "foreach" in s && typeof (s as ForeachStep).foreach === "string"
}

export function isWhenStep(s: RecipeStep): s is WhenStep {
  return "when" in s && typeof (s as WhenStep).when === "string"
}

export function isBrowserOrControlAction(s: RecipeStep): s is BrowserStep | SetStep | LogStep | CallStep | GotoStep {
  return "action" in s && typeof (s as { action?: unknown }).action === "string"
}
