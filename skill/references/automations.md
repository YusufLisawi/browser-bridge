# Automations — reusable recipes

Agents (and humans) can save repetitive browser flows as **recipes** and run
them unattended. Learn the flow once with `snapshot`/`act`, write a recipe,
then `bridge automation run` while you wait — or `--detach` and poll status.

## When to use

Use an automation when you would otherwise loop the same snapshot→act sequence
(e.g. delete each row: open → wait → delete → back → next).

Prefer one-off `act`/`eval` for a single page change.

## Layout

```
~/.browser-bridge/automations/<name>/
  recipe.yaml   # or recipe.json (required)
  hooks.mjs     # optional JS helpers
  README.md     # optional notes

~/.browser-bridge/runs/<runId>.json   # live status / result
```

## CLI

```bash
bridge automation list
bridge automation show <name>
bridge automation save <name> --file recipe.yaml [--hooks hooks.mjs] [--force]
bridge automation delete <name>

bridge automation run <name> [--var k=v]… [--tab active] [--wait|--detach] [--timeout ms]
bridge automation status [runId] [--json]
bridge automation wait <runId>
bridge automation cancel <runId>
bridge automation runs [--limit N]
bridge automation sync                       # push all recipes into the extension popup
```

Alias: `bridge auto …`

- **`--wait` (default):** stay attached, stream progress on stderr, exit 0/1.
- **`--detach`:** print `runId`, run in background; use `status` / `wait` later.
- **Popup:** after `bridge auto sync` (or save), open the extension popup — automations
  are grouped by `sites` (or inferred hosts). Click **Run** to replay without the agent.

## Agent workflow

1. Drive the task once with `bridge snapshot` / `bridge act` / `bridge eval`.
2. Write `recipe.yaml` capturing waits, selectors, `foreach`, retries.
3. `bridge auto save my-task --file /tmp/recipe.yaml`
4. `bridge auto run my-task --var limit=20` (or `--detach`)
5. Reuse later — no re-discovery.

Example offline recipe (no browser):

```bash
bridge auto save demo-loop --file examples/automations/demo-loop/recipe.json --force
bridge auto run demo-loop
```

Template for a delete-each-row flow:
`examples/automations/delete-rows/recipe.yaml` (edit selectors for your site).

## Recipe basics

Steps are today’s control actions (`click`, `waitFor`, `navigate`, `eval`, …)
plus control:

| Kind | Purpose |
|------|---------|
| `foreach` | Iterate an array in `vars` / `input` |
| `when` / `else` | Conditional block (`when: "vars.n > 0"`) |
| `set` | Write `vars` (`value` or `expr`) |
| `log` | Append to the run log |
| `call` | Run a named export from `hooks.mjs` |
| `goto` | Jump to a sibling step `id` |
| `snapshot` | Capture interactive elements → `as` |

**Interpolation:** `${vars.x}`, `${input.y}`, `${row.z}` in strings and nested fields.
Full-string placeholders keep the raw type (arrays/numbers), not stringified.

**Exprs** (`set.expr`, `when`): tiny safe language — paths, `+ - * /`, comparisons,
`&& ||`, `!`, strings, numbers. No arbitrary JS — use `hooks.mjs` for that.

**Policy:** per-step or `defaults`: `timeout`, `human`, `retry: { times, delayMs }`,
`onFail: abort|continue|goto:<id>`.

**`as`:** store `eval` / `getText` / `snapshot` / `call` results into `vars`.

## hooks.mjs

```js
export function pickDeleteTarget({ arg, vars }) {
  const hit = (arg.snapshot || []).find((n) => /delete/i.test(n.name || ""))
  if (!hit) throw new Error("no delete control")
  return hit.ref
}
```

```yaml
- action: snapshot
  as: lastSnapshot
- action: call
  hook: pickDeleteTarget
  arg: { snapshot: "${vars.lastSnapshot}" }
  as: deleteRef
- action: click
  target: "${vars.deleteRef}"
```

## Notes

- CLI runner: `bridge auto run` (wait/detach). Extension popup: one-click **Run** after `bridge auto sync`.
- Popup groups by `sites` (or inferred hosts). `call`/hooks.mjs steps are CLI-only.
- Only one `bridge` command can hold port 38471 at a time; popup runs do not need the CLI.
- Cancel is cooperative (CLI `cancel` or popup **Stop**).
- No session recorder in v1 — author recipes after learning the flow manually.
