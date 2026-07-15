# Browser Bridge — Troubleshooting & internals

## Contents
- Connection problems
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
- Port busy: `lsof -ti:8787 | xargs kill` if a stale `bridge`/server is holding
  8787 ("Port 8787 is in use — another 'bridge' command may be running.").
- Check the extension popup: **Bridge ready** (green) = the connection layer is
  alive and listening; **Starting** / **Error** = the offscreen document failed
  to boot. The popup also shows a recent-command feed and last-command status —
  if commands appear there with ✓, the bridge is working. If it's stuck on
  **Starting**, the offscreen script failed (it may use **only**
  `chrome.runtime` messaging, not `chrome.storage`/`chrome.tabs`; state is
  relayed to the service worker which persists it).

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

- **CLI (`cli/`)** — ephemeral WS server per invocation. `dispatch` (one job),
  `dispatchBatch` (many jobs, one socket, sequential). `ratelimit.ts` enforces
  LinkedIn caps in `~/.browser-bridge/usage.json`. HTML→Markdown via `turndown`.
- **Extension (`extension/src/`)**:
  - `offscreen.ts` — holds the WebSocket, reconnect/backoff. Only uses
    `chrome.runtime` messaging.
  - `background.ts` — orchestrator. Owns navigation. Generic `read`/`snapshot`/
    `act`/`eval` use `chrome.scripting.executeScript` (so they work on any
    page) + a dedicated background "bridge tab"; LinkedIn uses the content
    script + the LinkedIn tab. `eval` injects into the MAIN world; `act` adds
    human-like scroll/mouse motion. Also records a recent-job ring buffer to
    `chrome.storage` for the popup.
  - `capture.ts` — MAIN-world hook (console.*, window errors, fetch, XHR) that
    `monitor` registers via `chrome.scripting.registerContentScripts` at
    `document_start`; `logs`/`network` read its `window.__bbCapture` buffer. No
    `chrome.debugger` (deliberately — no "being debugged" banner).
  - `content.ts` — stateless scraper executor for LinkedIn commands.
  - `lib/scrape-*.ts` — LinkedIn extractors; `pacing.ts` — human-like delays.
- **Protocol (`shared/protocol.ts`)** — Job/JobResult types shared by both sides.
- Manifest `host_permissions` is `http/https <all_urls>` so `read` works anywhere.
