# Browser Bridge Automations — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship CLI-side reusable automations (`bridge automation …`) per [2026-07-14-automation-plugins-design.md](./2026-07-14-automation-plugins-design.md).

**Architecture:** Long-lived CLI WebSocket session + recipe step engine on disk under `~/.browser-bridge/`. Extension protocol stays as-is (reuse `act` / `eval` / `snapshot`).

**Tech notes:** Prefer JSON recipes in the first vertical slice; add YAML when the engine works. No extension reload required for core runner.

---

## Task 1: Long-lived session API

**Files:**
- Modify: `cli/server.ts`
- Test: `cli/server.session.test.ts` (or project’s existing test runner if none — add minimal node:test)

**Steps:**
1. Extract shared WS bind/wait-for-client logic from `dispatch` / `dispatchBatch`.
2. Add `createSession(opts) → { send(job, timeoutMs?), close() }` that keeps the socket open across many jobs.
3. Implement `dispatch` and `dispatchBatch` as thin wrappers over the session (preserve current behavior + default 180s per job).
4. Handle `EADDRINUSE` and duplicate connections the same way as today.
5. Verify: existing CLI commands still work (`bridge ping`).

**Done when:** `createSession` can send ≥2 jobs sequentially without closing between them.

---

## Task 2: Paths, run store, recipe types

**Files:**
- Create: `cli/automations/paths.ts` — `~/.browser-bridge/automations`, `…/runs`
- Create: `cli/automations/types.ts` — Recipe, Step, RunState, InputSpec
- Create: `cli/automations/store.ts` — load/save recipe dir; read/write run JSON; list runs
- Create: `cli/automations/validate.ts` — structural validation

**Steps:**
1. Define TypeScript types matching the design (browser actions ∪ control steps).
2. Implement `ensureDirs()`, `listAutomations()`, `loadRecipe(name)`, `saveAutomation(name, files)`, `writeRun` / `readRun` / `listRuns`.
3. Accept `recipe.json` first; if `recipe.yaml` present, parse only after Task 6 (or stub with clear error).
4. Unit-test validate + store round-trip with a temp HOME dir (`BRIDGE_HOME` override).

**Done when:** Can save/load a minimal recipe JSON and a run state file under a fake home.

---

## Task 3: Interpolation + tiny expressions

**Files:**
- Create: `cli/automations/interp.ts`
- Test: `cli/automations/interp.test.ts`

**Steps:**
1. Implement `${vars.x}`, `${input.x}`, foreach item `${row.x}` replacement in strings and deep in objects.
2. Implement safe `expr` evaluator for `set` / `when` (literals, `+`, `-`, comparisons, property paths on context) — **no** `Function`/`eval` on recipe strings.
3. Reject unknown placeholders loudly.

**Done when:** Unit tests cover nested objects, missing paths, and simple arithmetic `vars.deleted + 1`.

---

## Task 4: Step engine (control + browser)

**Files:**
- Create: `cli/automations/engine.ts`
- Test: `cli/automations/engine.test.ts` with a mock `send`

**Steps:**
1. Implement runner: init vars/input → walk steps → persist run after each step/iteration.
2. Control: `foreach`, `when`, `set`, `log`, `goto`, `call` (dynamic `import` of `hooks.mjs`).
3. Browser: map action steps to `ActJob` / `EvalJob` / `SnapshotJob` via session `send`; honor `as`, `retry`, `onFail`, `timeout`, `human`.
4. Cooperative cancel: check `runs/<id>.cancel` or status flag between steps.
5. Produce terminal statuses: `done` | `failed` | `cancelled` + summary string.

**Done when:** Mocked foreach recipe increments `vars.deleted` and writes a completed run file.

---

## Task 5: CLI commands

**Files:**
- Modify: `cli/index.ts`
- Create: `cli/automations/commands.ts` (optional split)

**Steps:**
1. Add `automation` / `auto` subcommand router: `list`, `show`, `save`, `delete`, `run`, `status`, `wait`, `cancel`, `runs`.
2. `run`: default `--wait` (foreground engine); `--detach` spawn detached Node child with same entry + `--run-id` / internal flag; print run id.
3. Stream progress lines on wait (`[3/20] each-row click …`).
4. Wire `--var key=value`, `--tab`, `--timeout`, `--json`.
5. Update `--help` text.

**Done when:** `bridge auto save` + `bridge auto run demo --wait` works against a recipe that only uses `log`/`set` (no browser) and against a live `eval` recipe when extension is up.

---

## Task 6: YAML support (optional polish)

**Files:**
- Modify: `cli/automations/store.ts`
- Add dep: `yaml` (or equivalent) in `package.json`

**Steps:**
1. If `recipe.yaml` exists, parse to the same Recipe type.
2. Prefer yaml if both exist? Document: prefer `recipe.yaml`, else `recipe.json`.
3. Keep JSON fixtures in tests.

**Done when:** The design-doc delete-rows YAML sketch loads and validates.

---

## Task 7: Skill + README docs

**Files:**
- Create: `skill/references/automations.md`
- Modify: `skill/SKILL.md` — link + short recipe
- Modify: `README.md` — one “Automations” section

**Steps:**
1. Document author loop: learn → write → save → run/wait/detach.
2. Include delete-rows example and CLI table.
3. Note: no recording; user library path; cancel semantics.

**Done when:** An agent reading the skill can author and run an automation without reading the design doc.

---

## Task 8: Smoke test + ship checklist

**Steps:**
1. `npm run build` / `typecheck`.
2. Manual: `bridge ping` still works.
3. Manual: save + run foreach `eval` automation that returns a fixed array and logs each item.
4. Manual: `--detach` → `status` → `wait`.
5. Do **not** commit unrelated WIP (eval/monitor diff) unless asked — keep automation work on its own commits.

**Done when:** Smoke checklist passes on a machine with the extension loaded.

---

## Suggested commit slices

1. `feat(cli): long-lived WebSocket session for multi-job runs`
2. `feat(cli): automation recipe store, validation, and run state`
3. `feat(cli): automation step engine with foreach/vars/retry`
4. `feat(cli): bridge automation / auto commands`
5. `docs: agent guide for reusable automations`

## YAGNI reminders

- No extension changes required for v1.
- No project-local `.bridge/` paths.
- No recorder.
- No parallel foreach.
- Tiny expr language only — push complexity into `hooks.mjs`.
