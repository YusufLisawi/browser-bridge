# Browser Bridge — Control (drive the browser)

Beyond reading, `bridge` can act: inspect tabs, see a page (snapshot/screenshot),
and operate it (click/fill/select/press). This is how an LLM drives the user's
real, logged-in browser.

## Contents
- The agent loop
- Tabs
- Seeing a page (snapshot + screenshot)
- Acting (action schema)
- Targeting tabs
- Limits

## The agent loop

```
navigate/open  →  snapshot (or screenshot)  →  act  →  (auto re-snapshot)  →  repeat
```

1. `bridge tabs` to find the tab, or `bridge navigate <url>` on the bridge tab.
2. `bridge snapshot` → interactive elements with stable refs (`e1`, `e2`, …).
3. Decide, then `bridge act '[…steps]'` addressing elements **by ref** (robust)
   or by CSS/XPath selector. `act` returns a fresh snapshot by default, so you
   see the new state without a second call.

Prefer **refs from a fresh snapshot** over hand-written selectors — refs are
tagged onto the live DOM (`data-bb-ref`) and survive until the page changes.

## Tabs

```bash
bridge tabs                      # list open tabs: id, ▸=active, title, url
bridge tab activate <id>         # focus a tab (also focuses its window)
bridge tab close <id>
bridge tab new <url>
```

## Seeing a page

```bash
bridge snapshot [--tab x]        # interactive elements (the LLM's "eyes", text)
bridge read --tab active         # full page → Markdown + contacts (no navigation)
bridge screenshot [--tab x] --out shot.png
```

**Screenshots → agent:** `screenshot` writes a PNG file (default
`bridge-screenshot.png`, or `--out path`). The extension can't "show" you the
image — **read the saved file with your image-read tool** to see it. Loop:
`bridge screenshot --out /tmp/s.png` → read `/tmp/s.png`.
Note: capture briefly activates the target tab then restores the prior one
(slight flicker); `chrome://`/extension pages can't be captured.

## Acting

`bridge act '<json>'` takes one action object or an array. Each step:

```json
{ "action": "<verb>", "target": "<ref|selector>", "text": "...", "value": "...", "key": "...", "url": "...", "timeout": 10000 }
```

Verbs: `click`, `fill` (= `type`/`setValue`), `select` (by option value or
label, uses `value`), `check`, `uncheck`, `press` (uses `key`; `target`
optional — defaults to the focused element; `Enter` in a field submits its
form), `hover`, `focus`, `scroll` (uses `deltaY`, or `target:"top"|"bottom"`),
`scrollIntoView`, `waitFor` (poll for `target` up to `timeout`), `waitForUrl`
(poll until the URL contains `target` — use after a click that triggers SPA
routing), `submit`, `getText`, `getValue`, `eval` (run JS — see below),
`navigate` (uses `url`).

By default a batch is **fail-fast**: the first failing step stops the rest
(so step 4 never runs against the wrong state if step 3 fails). Pass
`--continue-on-error` to run every step regardless.

## Running custom JS (the "do anything" primitive)

When no combination of actions fits, run arbitrary JavaScript in the page:

```bash
bridge eval 'return document.title'                 # → the title
bridge eval 'return [...document.querySelectorAll("h2")].map(h=>h.innerText)'
bridge eval --file scrape.js --tab active --out data.json
bridge eval 'await fetch("/api/me").then(r=>r.json())' --json   # async + await OK
bridge eval 'return arg.a + arg.b' --arg '{"a":1,"b":2}'        # pass data in via arg
```

- Code runs as the body of an **async function** in the page's MAIN world, so
  `await` works and `return <value>` sends a JSON-serializable result back.
- `--arg <json>` exposes a value to the code as `arg`.
- `--timeout <ms>` bounds an async result (default 15000). A synchronous
  infinite loop can't be interrupted — don't write one.
- DOM nodes/functions aren't serializable; return plain data (strings, numbers,
  arrays, objects). For elements, return `el.outerHTML` or extracted fields.

`eval` is also an **action**, so a single batch can mix UI steps with custom
JS and capture its result:
```bash
bridge act '[
  {"action":"click","target":"e5"},
  {"action":"waitForUrl","target":"/dashboard","timeout":10000},
  {"action":"eval","code":"return document.querySelectorAll(\".row\").length","as":"rowCount"}
]'
```
Each step's structured return appears in its result (`json`); with `--json` you
get the full machine-readable batch back.

Example — fill and submit a form:
```bash
bridge snapshot                                  # → find refs e1 (name), e3 (email), e13 (submit)
bridge act '[
  {"action":"fill","target":"e1","text":"Jane Doe"},
  {"action":"fill","target":"e3","text":"jane@co.com"},
  {"action":"click","target":"e13"},
  {"action":"waitFor","target":"h1","timeout":10000}
]'
```

Shortcuts (each = one act step): `bridge click <t>`, `bridge fill <t> <text>`,
`bridge select <t> <value>`, `bridge check|uncheck <t>`, `bridge press <key> [t]`,
`bridge scroll [top|bottom|<px>]`, `bridge move <t>|<x> <y>`, `bridge navigate <url>`.
Add `--no-snapshot` to skip the after-action snapshot, `--json`/`--out` to
capture results.

## Human-like interaction

Synthetic events are still `isTrusted:false`, but you can pace them like a
person — useful on sites with behavioural heuristics, and to trigger lazy
content correctly.

- `--human` on `click`/`scroll` (or `"human": true` on an act step): jittered
  multi-step motion with randomized delays instead of one robotic jump.
- `bridge scroll bottom --human` scrolls down in many small randomized steps
  (with occasional re-read jitter) until the page bottom — the right way to load
  infinite-scroll feeds.
- `bridge move <ref|sel>` (or `bridge move <x> <y>`) glides a synthetic cursor to
  the target along an eased, slightly-wobbly path, firing `mousemove`. Pair it
  before a click for a more human gesture: a `click` with `"human":true` already
  does move→pause→down→up→click.

## Capturing console logs + network (no debugger banner)

`monitor` arms a lightweight in-page hook (wraps `console.*`, window errors,
`fetch`, `XMLHttpRequest`) — **no `chrome.debugger`, so no "being debugged"
banner**. Read the buffer per tab.

```bash
bridge monitor start            # arm capture (also injects into open tabs)
# reload / navigate the page so the hook is present from load…
bridge logs --tab active        # console messages + uncaught errors
bridge network --tab active     # fetch/XHR: status, method, url, timing, body
bridge network --tab active --json --out net.json
bridge logs --clear             # read then empty the buffer
bridge monitor stop             # disarm
```

Fidelity limits (by design — this is the non-CDP path): it sees **app-level
`fetch`/XHR only** (not static document/image/css/script loads), and only what
happens **after** the hook installs (reload to capture from page load). Response
bodies are captured truncated for text/JSON responses. For full network/CDP-level
interception there is intentionally no support — it would require the debugger
banner.

## Targeting tabs

`--tab` selects where actions/snapshot/screenshot run:
- `bridge` (default) — a dedicated background tab; doesn't disturb the user.
- `active` — whatever tab the user is currently focused on.
- `<id>` — a specific open tab id (from `bridge tabs`).

Use the background tab for autonomous flows; use `active`/`<id>` to operate a
page the user already opened.

## Limits (Tier 1)

- Events are synthetic (`isTrusted:false`) — works on the vast majority of forms
  incl. React/Vue controlled inputs, but not sites that demand trusted input.
- File-upload inputs can't be set programmatically.
- Cross-origin iframes and (for now) closed shadow roots aren't traversed.
- For trusted input / file uploads / silent background-tab capture, a Tier-2
  `chrome.debugger`/CDP path would be needed (not built).
