# Browser Bridge Automations — Design

**Date:** 2026-07-14  
**Status:** Approved (best-effort completion while AFK)  
**Goal:** Let agents author reusable automations for repetitive browser tasks, run them unattended from the CLI, and wait or poll until done.

## Problem

Today Browser Bridge is a **stateless request/response bridge**. Agents drive pages via an external `snapshot → act → snapshot → act…` loop. Each `bridge` command opens an ephemeral WebSocket, runs one job (or a sequential batch), and exits.

That works for one-off control. It fails for repetitive flows such as:

> For each list row: open it → wait for detail → click Delete → go back → next row.

The agent must stay in the loop, re-issue commands, manage waits/fallbacks itself, and cannot hand off a durable recipe to run later.

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Recipe model | **Hybrid** — declarative YAML/JSON steps + optional JS hooks |
| Runtime location | **CLI-side runner** (Node keeps WS open for the whole run) |
| Authoring | **Write after learning** — agent does the task once via snapshot/act, then writes a recipe. No recording in v1 |
| Storage | **User library only** — `~/.browser-bridge/automations/<name>/` |
| Completion | **Both** — `--wait` (default) and `--detach` + status/wait/cancel |

**Rejected for v1:** JS-only SDK scripts as the primary form; MV3 mini-extension plugins; project-local recipe trees; session recording.

## Architecture

```
Agent
  │  write recipe after learning the flow
  ▼
~/.browser-bridge/automations/<name>/
  recipe.yaml (+ optional hooks.mjs)
  │
  │  bridge automation run <name> [--wait|--detach]
  ▼
CLI Automation Runner (Node)
  • load + validate recipe
  • open ONE long-lived WS (session, not one-shot)
  • step engine: interpolate → dispatch act/eval/snapshot → update vars
  • persist run state continuously
  ▼
Extension (unchanged job kinds)
  act | eval | snapshot | navigate | …
  ▼
~/.browser-bridge/runs/<runId>.json   ← status / progress / result
```

Single-shot commands (`ping`, `read`, `act`, …) keep today’s ephemeral `dispatch()`. Only automation runs use a persistent session.

## Recipe shape

### Layout

```
~/.browser-bridge/automations/delete-rows/
  recipe.yaml      # required
  hooks.mjs        # optional — named exports callable from steps
  README.md        # optional — human/agent notes
```

### Schema (conceptual)

```yaml
name: delete-rows
description: Open each list row, delete it, go back
version: 1
tab: active                 # bridge | active | <tabId>
vars:                       # initial memory
  deleted: 0
  failed: []

input:                      # --var at run time
  limit: { type: number, default: 50 }

defaults:
  timeout: 15000
  human: true
  retry: { times: 2, delayMs: 800 }
  onFail: abort             # abort | continue

steps:
  - id: collect
    action: eval
    code: |
      return [...document.querySelectorAll('[data-row]')]
        .slice(0, arg.limit)
        .map((el, i) => ({ index: i, href: el.querySelector('a')?.href }))
    arg: { limit: "${input.limit}" }
    as: rows

  - id: each-row
    foreach: "${vars.rows}"
    as: row
    steps:
      - action: navigate
        url: "${row.href}"
      - action: waitFor
        target: "button[data-delete], [aria-label='Delete']"
      - action: click
        target: "button[data-delete], [aria-label='Delete']"
        onFail: continue
      - action: waitForUrl
        target: "/list"
      - action: set
        var: deleted
        expr: "vars.deleted + 1"

onComplete:
  summary: "Deleted ${vars.deleted} rows; failed: ${vars.failed}"
```

### Step kinds

**Browser actions (reuse today’s `ActionStep`):**  
`click`, `fill`, `type`, `select`, `check`, `uncheck`, `press`, `hover`, `focus`, `scroll`, `scrollIntoView`, `mouseMove`, `waitFor`, `waitForUrl`, `submit`, `getText`, `getValue`, `eval`, `navigate`, plus `snapshot` as an explicit step when needed.

**Control (new, runner-only — never sent to the extension as-is):**

| Kind | Purpose |
|------|---------|
| `foreach` | Iterate an array in `vars` / `input`; nested `steps` |
| `when` | Conditional block (`eq` / `truthy` / simple expr) |
| `set` | Write `vars` (`value` literal or `expr` string) |
| `call` | Invoke `hooks.mjs` export; result → `as` |
| `log` | Append a message to the run log |
| `goto` | Jump to a step `id` (rare; prefer foreach) |

**Per-step policy fields:** `id`, `retry`, `onFail` (`abort` \| `continue` \| `goto:<id>`), `timeout`, `human`, `as`.

### Variables & interpolation

- `${input.*}`, `${vars.*}`, `${row.*}` (foreach item), `${env.*}` (allowlisted: nothing secret by default)
- `as: name` on `eval` / `getText` / `call` / `snapshot` stores into `vars`
- Expressions for `set` / `when` are a **tiny safe eval** (numbers, strings, `+`, comparisons, property access on the vars bag) — not arbitrary Node `eval`
- Hooks (`hooks.mjs`) get full JS when the agent needs real logic

### JS escape hatch

```yaml
- action: call
  hook: pickDeleteTarget
  arg: { snapshot: "${vars.lastSnapshot}" }
  as: deleteTarget
```

`hooks.mjs`:

```js
export function pickDeleteTarget({ arg }) {
  const hit = arg.snapshot.find((n) => /delete/i.test(n.name || ""))
  if (!hit) throw new Error("no delete control in snapshot")
  return hit.ref
}
```

## Runtime

### Session

New CLI helper (conceptual): `withSession(fn)` — bind `127.0.0.1:8787`, wait for extension, keep the socket open, expose `send(job) → JobResult` until the runner finishes. Built by generalizing today’s `dispatchBatch` connection loop (not a separate daemon).

### Step engine

1. Load + validate recipe; merge `--var` into `input`; init `vars`.
2. Create run record (`status: running`).
3. For each step (depth-first through foreach/when):
   - Interpolate fields.
   - If control step → handle locally.
   - If browser step → send one `act` (single step or small batch) or `eval` / `snapshot` job via session.
   - Apply `retry` on failure; then `onFail`.
   - Persist run state after each step (or each foreach iteration).
4. Mark `done` / `failed`; write summary; exit.

### Run state file

`~/.browser-bridge/runs/<runId>.json`:

```json
{
  "id": "run_01J…",
  "automation": "delete-rows",
  "status": "running",
  "pid": 12345,
  "startedAt": "…",
  "finishedAt": null,
  "step": "each-row/3/click",
  "progress": { "iteration": 3, "total": 20 },
  "vars": { "deleted": 3, "failed": [] },
  "log": ["…"],
  "error": null,
  "summary": null
}
```

### Wait / detach

| Command | Behavior |
|---------|----------|
| `bridge automation run <name> [--var k=v]…` | Default **`--wait`**: stream progress, exit 0/1 |
| `… --detach` | Spawn/background runner, print `runId`, return immediately |
| `bridge automation status [id]` | Latest or specific run JSON (human or `--json`) |
| `bridge automation wait <id>` | Block until terminal status |
| `bridge automation cancel <id>` | Write cancel flag; runner stops between steps |

Detach implementation (v1): child process + pid in run file (no extra daemon). Cancel is cooperative (check flag between steps).

### Timeouts

- Per-step: `defaults.timeout` / step override (maps to act/eval timeouts).
- Per-run: `--timeout` (default e.g. 30 minutes) — runner aborts if exceeded.
- Remove the effective “whole automation must finish in 180s” ceiling by using session `send` with per-job timeouts only.

## CLI surface

```bash
bridge automation list
bridge automation show <name>
bridge automation save <name> --file recipe.yaml [--hooks hooks.mjs] [--force]
bridge automation delete <name>

bridge automation run <name> [--var k=v]… [--tab …] [--wait|--detach] [--timeout ms] [--json]
bridge automation status [runId] [--json]
bridge automation wait <runId> [--json]
bridge automation cancel <runId>
bridge automation runs [--limit N]   # recent runs
```

Aliases: `bridge auto …` for less typing.

`save` copies into the user library so agents can write a temp file then register it.

## Agent workflow

1. **Learn once:** `snapshot` / `act` / `eval` interactively until the flow works.
2. **Author:** write `recipe.yaml` (+ hooks if needed) capturing waits, selectors/refs strategy, foreach, retries.
3. **Save:** `bridge automation save delete-rows --file /tmp/recipe.yaml`.
4. **Run:** `bridge automation run delete-rows --var limit=20` (wait) or `--detach`.
5. **Reuse:** later runs need no re-discovery — only input vars.

Skill docs (`skill/references/`) get an `automations.md` describing this loop and the schema.

## Error handling

- Validation errors before any browser work (unknown action, bad foreach path, missing hook).
- Step failure → retry → `onFail`.
- Extension disconnect mid-run → mark `failed` with clear error; do not silently half-complete without status update.
- Cancel → `status: cancelled`.
- Hooks throwing → treated as step failure.

## Out of scope (v1)

- Recording / “learn mode”
- Project-local (`.bridge/`) recipe trees
- Parallel foreach / multi-tab fan-out
- Cron / schedules
- Extension-side execution that outlives the CLI process
- Full JS expression language in YAML
- Guaranteed recovery after Chrome crash mid-run (best-effort status only)
- Marketplace / sharing format beyond a folder copy

## Testing

- Unit: interpolation, foreach expansion, retry/`onFail`, cancel flag, recipe validation.
- Integration (manual or scripted with mock session): run a fixture recipe that only uses `eval`/`log`/`set` against a live extension when available.
- Golden: delete-rows-shaped fixture with a mocked `send()` that returns canned snapshots.

## Success criteria

An agent can:

1. Save a foreach-based recipe after doing a task once.
2. Run it with `--wait` and get a summary without driving each iteration itself.
3. Run with `--detach`, do other work, then `status`/`wait` until done.
4. Use vars + retries + `onFail: continue` so one bad row does not kill the batch.

## Implementation sketch (for planning)

1. **Session API** in `cli/server.ts` — long-lived WS with `send(job)`.
2. **Recipe types + loader** — YAML parse (add dependency) or JSON-first with YAML optional.
3. **Step engine** — control + browser dispatch + vars + run persistence.
4. **CLI commands** — `automation` / `auto` subcommands.
5. **Skill docs** — authoring guide + delete-rows example.
6. **Tests** — engine unit tests without Chrome.

Prefer **JSON recipes in the very first slice** if YAML adds friction; accept `.yaml` once a parser is in place. Keep extension protocol changes minimal — ideally **none** for v1 beyond using existing jobs.
