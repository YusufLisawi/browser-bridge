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
form), `hover`, `focus`, `scrollIntoView`, `waitFor` (poll for `target` up to
`timeout`), `submit`, `getText`, `getValue`, `navigate` (uses `url`).

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
`bridge navigate <url>`. Add `--no-snapshot` to skip the after-action snapshot,
`--json`/`--out` to capture results.

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
