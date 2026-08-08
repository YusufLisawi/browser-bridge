# Browser Bridge — Troubleshooting & internals

## Contents
- Connection problems
- Snapshot / screenshot hang while tabs / navigate work
- Multi-agent / concurrent CLI use
- Empty / wrong results
- LinkedIn DOM changed (re-tuning selectors)
- Rebuilding after code changes
- Architecture reference

## Connection problems

`bridge ping` hangs on "Waiting for the extension to connect…":
- Chrome must be open with the **Browser Bridge** extension loaded
  (`chrome://extensions`, Developer mode, Load unpacked →
  `~/Developer/browser-bridge/extension/dist`).
- The CLI is the WS *server*; the extension is the *client* and reconnects on a
  fast backoff loop (first retries ~250ms). Because the server is ephemeral, the
  socket is "connected" only for the brief window a command runs — so the popup
  shows **Bridge ready** (extension alive + listening), not a persistent
  "connected" state. After starting a command it connects within ~1s.
- Port busy: only one `bridge` process can hold `38471` at a time. A second
  command **waits in line** on `~/.browser-bridge/bridge.lock` (then the port;
  up to ~180s, override with `BRIDGE_PORT_WAIT_MS`) and prints
  `Waiting for another bridge command to finish…` (often with the holder pid).
  If the wait expires: check `cat ~/.browser-bridge/holder.json`, or
  `lsof -ti:38471 | xargs kill` for a stale holder. Do **not** kill just because
  another agent is legitimately queued.
- Advanced: `BRIDGE_WS_PORT` overrides the CLI bind port (extension must be
  rebuilt with the same `WS_PORT` in `shared/protocol.ts` — they must match).
- Check the extension popup: **Bridge ready** (green) = the connection layer is
  alive and listening; **Starting** / **Error** = the offscreen document failed
  to boot. The popup also shows a recent-command feed and last-command status —
  if commands appear there with ✓, the bridge is working. If it's stuck on
  **Starting**, the offscreen script failed (it may use **only**
  `chrome.runtime` messaging, not `chrome.storage`/`chrome.tabs`; state is
  relayed to the service worker which persists it).

## Snapshot / screenshot hang while tabs / navigate work

This pattern means the **page-scripting path** is wedged, not the WebSocket:

- `tabs` / navigate URL change only use `chrome.tabs` → stay fast.
- `snapshot` / `screenshot` / most `act` / `read` inject JS or capture pixels →
  hang if the MV3 service worker or tab renderer is stuck.

**Do not spam retries.** Reload the extension in `chrome://extensions` (click ↻
on Browser Bridge), then `bridge ping` and retry. Timeouts now fail within ~45–60s
with a reload hint instead of sitting for 180s.

Also check: popup job feed for a stuck last command; only one agent should be
driving the browser (others wait on the port queue).

## Multi-agent / concurrent CLI use

Browser control is **serialized** (one job at a time) — this is intentional and
safe for many agents:

1. **CLI lock:** `~/.browser-bridge/bridge.lock` — exclusive; waiters queue fairly.
   Active holder is recorded in `~/.browser-bridge/holder.json` (pid + command).
2. **Port bind:** `127.0.0.1:38471` — second layer; wait/retry if needed.
3. **Extension queue:** background SW runs jobs (and popup automations) through
   a single-flight mutex so CLI + popup never interleave on the same tab /
   `data-bb-ref` set / screenshot focus.

Still: one shared browser — agents take turns, they do not run in parallel.
Port `38471` was chosen to avoid common collisions (e.g. other tools on `8787`).

## Empty / wrong results

- **`read` returns thin content:** the page renders late. It already scrolls +
  waits, but some SPAs need more. Try re-reading, or read a more specific URL
  (e.g. the article/contact page rather than a JS-heavy hub).
- **No `contacts`:** site hides contact info behind a form or only on `/contact`.
  Read `/contact`, `/about`, `/team`, or `crawl --same-host`.
- **SERP looks like junk:** you used DuckDuckGo Lite over GET — switch to Google
  (`https://www.google.com/search?q=...`).
- **`profile` fields wrong/empty after a LinkedIn redesign:** selectors drifted.
  Re-tune (below).

## LinkedIn DOM changed — re-tuning selectors

LinkedIn uses hashed CSS classes that rotate, plus periodic redesigns. The
scrapers in `~/Developer/browser-bridge/extension/src/lib/scrape-*.ts` anchor on
*structure* (e.g. `[role="list"]` + profile-link cards for search;
`section[aria-label="Primary content"]` + leaf-text lines for profiles), not
classes. When they break, dump the live DOM with the probe commands:

```bash
bridge probe "<query>"            # navigates a people-search, dumps structure
bridge probe-profile "<url>"      # navigates a profile (or /details/ page), dumps structure
```

The probe returns section headings, `role=list` info, `[data-view-name]` counts,
sample card/section HTML, and detected followers/connections text. Use it to
find new anchors, then update `scrape-search.ts` / `scrape-profile.ts`, rebuild,
and reload (below). The probe also accepts a full URL (incl. `/details/...`).

## Rebuilding after code changes

```bash
cd ~/Developer/browser-bridge
npm run build         # CLI → dist-cli, extension → extension/dist
npm run build:ext     # extension only (faster)
npm run typecheck
```

**Critical dev-loop gotcha:** any change to `background.js`/`content.js`/
`capture.js`/`popup`/manifest requires a **manual extension reload** in
`chrome://extensions` (click ↻).
Chrome does not hot-swap them. If you start a `bridge` command *before* reloading,
the **old** build answers (the extension stays connected) — so reload FIRST,
then run. CLI-only changes (`dist-cli`) take effect immediately, no reload.

## Architecture reference

- **CLI (`cli/`)** — ephemeral WS server per invocation on `127.0.0.1:38471`.
  `dispatch` (one job), `dispatchBatch` (many jobs, one socket, sequential).
  Concurrent CLIs **queue** via `~/.browser-bridge/bridge.lock` then the port
  (wait/retry) instead of racing. `ratelimit.ts` enforces LinkedIn caps in
  `~/.browser-bridge/usage.json`. HTML→Markdown via `turndown`.
- **Extension (`extension/src/`)**:
  - `offscreen.ts` — holds the WebSocket, reconnect/backoff, single-flight job
    relay with a timeout. Only uses `chrome.runtime` messaging.
  - `background.ts` — orchestrator. Global job queue serializes CLI + popup
    work. Owns navigation. Generic `read`/`snapshot`/`act`/`eval` use
    `chrome.scripting.executeScript` (with hard timeouts) + a dedicated
    background "bridge tab"; LinkedIn uses the content script + the LinkedIn
    tab. `eval` injects into the MAIN world; `act` adds human-like scroll/mouse
    motion. Also records a recent-job ring buffer to `chrome.storage` for the
    popup.
  - `capture.ts` — MAIN-world hook (console.*, window errors, fetch, XHR) that
    `monitor` registers via `chrome.scripting.registerContentScripts` at
    `document_start`; `logs`/`network` read its `window.__bbCapture` buffer. No
    `chrome.debugger` (deliberately — no "being debugged" banner).
  - `content.ts` — stateless scraper executor for LinkedIn commands.
  - `lib/scrape-*.ts` — LinkedIn extractors; `pacing.ts` — human-like delays.
- **Protocol (`shared/protocol.ts`)** — Job/JobResult types shared by both sides.
- Manifest `host_permissions` includes `<all_urls>` (+ explicit http/https/file) so `read`/`act`/`eval` work on any normal website. In `chrome://extensions` → Browser Bridge → Site access, set **On all sites**. Chrome still blocks `chrome://`, the Web Store, and similar restricted URLs — no extension can override that.
