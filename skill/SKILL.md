---
name: browser-bridge
description: >-
  Drive the user's real, logged-in browser from the terminal via the `bridge`
  CLI (local MV3 extension + WebSocket bridge at ~/Developer/browser-bridge).
  Use when a task needs live web content or control of the user's own browser:
  reading a page as Markdown, scraping/extracting from a site, crawling links,
  finding B2B leads or contact info (emails/phones), Google search harvesting,
  scraping LinkedIn profiles, listing/switching tabs,
  screenshots, and controlling pages — filling/submitting forms, clicking,
  selecting, typing, pressing keys, human-like scrolling/mouse motion, running
  arbitrary JS in a page, and capturing its console logs + network (fetch/XHR).
  Triggers: "read this page / as markdown", "scrape this site", "find leads for
  X", "get emails/contacts from these sites", "search Google and extract", "look
  up this LinkedIn profile", "fill out this form", "log into this site", "what
  tabs are open", "screenshot this page", "control my browser", "do X on the page
  I have open", "run this JS / script on the page", "scroll to the bottom",
  "what's the console showing", "what network/API calls is this page making".
  Prefer it over generic web-fetch when the page needs the user's login/session,
  renders client-side, passes a bot wall, or must be interacted with.
---

# Browser Bridge

A local CLI (`bridge`) drives the user's logged-in Chrome through an MV3
extension over a WebSocket on `127.0.0.1:8787`. It returns live page content as
**clean Markdown** (plus links and contact info), so you read tidy text instead
of parsing HTML. It also has LinkedIn-specific scrapers.

Project: `~/Developer/browser-bridge`. Run the CLI as `bridge <cmd>` if linked,
otherwise `node ~/Developer/browser-bridge/dist-cli/cli/index.js <cmd>`.

## Preflight (do this first)

The extension is a WebSocket *client* that only connects while a `bridge`
command is running. Before real work, confirm the chain is alive:

```bash
bridge ping     # → "✓ Extension connected and responding."
```

If it hangs on "Waiting for the extension to connect…", the browser side isn't
ready — see [references/troubleshooting.md](references/troubleshooting.md).

## Commands

| Command | Purpose |
|---|---|
| `bridge ping` | Verify the extension is connected |
| `bridge read <url> [<url>…] [--file f]` | Fetch any page(s) → Markdown + links + contacts |
| `bridge crawl <url> [--limit N] [--same-host]` | Read a page, follow its links, Markdown for each |
| `bridge tabs` · `bridge tab activate\|close\|new <id\|url>` | List / manage open tabs |
| `bridge snapshot [--tab x]` | List a page's interactive elements with refs (e1,e2…) |
| `bridge screenshot [--tab x] --out f.png` | Capture a PNG (then read the file to "see" it) |
| `bridge act '<json>'` · `click`/`fill`/`select`/`check`/`press`/`scroll`/`navigate` | Drive the page |
| `bridge scroll [top\|bottom\|<px>] [--human]` · `bridge move <ref\|sel>` | Scroll / glide a synthetic cursor (`--human` = jittered pacing) |
| `bridge eval '<js>' [--tab x] [--arg json] [--file f]` | Run arbitrary JS in a page; `return` a value (the "do anything" primitive) |
| `bridge monitor start\|stop\|status` · `bridge logs` · `bridge network` | Capture console logs + fetch/XHR (no debugger banner) |
| `bridge automation` / `bridge auto` | Save/run reusable recipes (`list\|show\|save\|run\|status\|wait\|cancel`) |
| `bridge search "<query>" [--pages N]` | LinkedIn people search → name/headline/location/URL |
| `bridge profile <url\|slug\|name>` | LinkedIn profile (first page only): card + latest post |
| `bridge profiles <url>… [--file f]` | Bulk LinkedIn profiles, one connection, paced |

**Output flags (all commands):** `--json` (raw JSON to stdout), `--out FILE`
(`.json` → JSON, anything else → Markdown). Default is human-readable to stdout.
`read` also takes `--links` (append the page's link list). For agent/scripting
use, prefer `--json --out` and parse the file.

## Core recipes

**Read a page as Markdown:**
```bash
bridge read "https://example.com/article" --out page.md
```

**Read many pages at once** (one socket, sequential, paced):
```bash
bridge read --file urls.txt --out pages.json   # one URL per line, # = comment
```

**Crawl one level** (page → its links → Markdown each):
```bash
bridge crawl "https://docs.site.com" --limit 15 --same-host --out docs.json
```

**Find leads (search → sites → contacts)** — the headline workflow:
```bash
# 1. Search (Google is reliable; see Tricks). Save the SERP as JSON.
bridge read "https://www.google.com/search?q=interior+design+firms+austin+tx" --json --out serp.json
# 2. Turn the SERP into clean lead homepages (decodes redirect links, filters junk).
node ~/.claude/skills/browser-bridge/scripts/leads.mjs serp.json > leads.txt
# 3. Read each lead site — `read` returns emails/phones/socials in `contacts`.
bridge read --file leads.txt --json --out leads.json
```
Then read `leads.json`: each entry is `{ url, title, markdown, links, contacts }`.
Pull `contacts.emails / contacts.phones / contacts.socials` for the lead sheet;
use `markdown` for context (services, about, location).

**LinkedIn lead sourcing:**
```bash
bridge search "real estate broker austin" --pages 2 --json --out people.json
# feed the profileUrls into bulk profile enrichment:
bridge profiles --file profile-urls.txt --out profiles.json
```

**Control a page (fill a form, click, log in):** snapshot → act by ref → repeat.
```bash
bridge navigate "https://site.com/signup"     # or operate an open tab: --tab active|<id>
bridge snapshot                                # → refs: e1 email, e2 password, e5 submit…
bridge act '[{"action":"fill","target":"e1","text":"jane@co.com"},
             {"action":"fill","target":"e2","text":"secret"},
             {"action":"click","target":"e5"},
             {"action":"waitForUrl","target":"/dashboard"}]'   # returns a fresh snapshot
```
A batch is **fail-fast** by default (first failing step stops the rest); add
`--continue-on-error` to run them all.

**Run arbitrary JS (the "do anything" primitive)** — when no action fits:
```bash
bridge eval 'return document.title'                            # return a value
bridge eval 'return [...document.querySelectorAll("h2")].map(h=>h.innerText)' --json
bridge eval 'await fetch("/api/me").then(r=>r.json())'         # async + await OK
bridge eval --file scrape.js --tab active --out data.json      # run a JS file
bridge eval 'return arg.x*2' --arg '{"x":21}'                  # pass data in via `arg`
```
Code runs as an async function body in the page's MAIN world; `return`
JSON-serializable data (for elements return `outerHTML`/fields, not the node).

**Load infinite-scroll feeds / act human-like:**
```bash
bridge scroll bottom --human   # many small jittered steps, not one jump
bridge move e7                 # glide a synthetic cursor to a ref, then…
bridge click e7 --human        # …move→pause→down→up→click pacing
```

**Reusable automation (repetitive task → recipe → run unattended):**
```bash
# After learning the flow once with snapshot/act, save a recipe:
bridge auto save delete-rows --file /tmp/delete-rows.yaml
bridge auto run delete-rows --var limit=20          # wait until done
bridge auto run delete-rows --var limit=20 --detach # background; then:
bridge auto status
bridge auto wait <runId>
```
See [references/automations.md](references/automations.md) for the recipe schema
(foreach, vars, retries, hooks).

**Capture console + network (no debugger banner):**
```bash
bridge monitor start           # arm capture (wraps console.*, errors, fetch, XHR)
# reload / navigate the page so the hook is present from load…
bridge logs --tab active                 # console messages + uncaught errors
bridge network --tab active --json --out net.json   # fetch/XHR: status, timing, body
bridge monitor stop            # disarm
```
Non-CDP path: sees app-level fetch/XHR only (not static resource loads), and
only events after the hook installs (reload to capture from page load).

Full step-by-step versions live in the reference files — read the one that fits:
- [references/recipes.md](references/recipes.md) — lead-gen pipeline, crawling, LinkedIn.
- [references/control.md](references/control.md) — the snapshot→act loop, full action
  schema, tabs, and screenshots-to-agent. **Read this before driving forms/buttons.**
- [references/automations.md](references/automations.md) — reusable recipes for
  repetitive tasks (foreach, vars, wait/detach). Sync with `bridge auto sync`
  to list & replay them from the extension popup (grouped by site).

## Tricks (non-obvious, important)

- **Paginate via the URL, not clicks.** Google: add `&start=10`, `&start=20`…
  (10/page). Most sites: `?page=2` or `&offset=N`. Issue each page as a separate
  `read` URL in one bulk call.
- **Google is the reliable SERP source.** DuckDuckGo Lite over GET often returns
  junk/unrelated results — don't trust it for harvesting. Prefer
  `https://www.google.com/search?q=...`.
- **Decode redirect links.** Google results are `…/url?q=REAL` and DDG are
  `…/l/?uddg=ENCODED`. `scripts/leads.mjs` already decodes both — use it instead
  of hand-parsing SERP links.
- **`read` is lead-aware.** Every `read` result includes a `contacts` field
  (emails from `mailto:` + body text, phones from `tel:` + patterns, socials)
  scraped from the *whole* page (including footers). This is the lead payload.
- **`read` beats plain fetch on live pages** — it scrolls to trigger lazy
  content and runs in the user's real session, so it passes logins and most bot
  walls a plain HTTP fetch would fail.
- **Bulk = one socket.** `read`/`profiles` with many targets reuse a single
  connection and run sequentially with pacing — don't loop single-item commands
  (slower, reconnect churn).
- **Generic `read`/`crawl` are uncapped; LinkedIn is rate-capped.** LinkedIn
  `profile`/`search` enforce a daily/hourly cap to protect the account
  (`BRIDGE_MAX_PROFILES_PER_DAY`, `BRIDGE_MAX_SEARCHES_PER_HOUR`). Raising them
  raises ban risk — keep LinkedIn volume low.
- **Background "bridge tab".** Generic reads navigate a dedicated background tab,
  so they don't disturb the user's active tab. LinkedIn commands use the
  existing LinkedIn tab.

## LinkedIn note

LinkedIn scraping is ToS-violating and detection is real; the only true
protection is low volume. Profile scrape is single-page by design (name,
headline, location, followers, connections, currentCompany, currentSchool,
latestPost). When LinkedIn ships a DOM change and selectors break, use the
probe commands to re-tune — see [references/troubleshooting.md](references/troubleshooting.md).
