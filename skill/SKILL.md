---
name: browser-bridge
description: >-
  Drive the user's real, logged-in browser from the terminal via the `bridge`
  CLI (local MV3 extension + WebSocket bridge at ~/Developer/linkedin-bridge).
  Use when a task needs live web content or control of the user's own browser:
  reading a page as Markdown, scraping/extracting from a site, crawling links,
  finding B2B leads or contact info (emails/phones), Google search harvesting,
  scraping LinkedIn profiles, listing/switching tabs,
  screenshots, and controlling pages — filling/submitting forms, clicking,
  selecting, typing, pressing keys. Triggers: "read this page / as markdown",
  "scrape this site", "find leads for X", "get emails/contacts from these
  sites", "search Google and extract", "look up this LinkedIn profile", "fill
  out this form", "log into this site", "what tabs are open", "screenshot this
  page", "control my browser", "do X on the page I have open". Prefer it over
  generic web-fetch when the page needs the user's login/session, renders
  client-side, passes a bot wall, or must be interacted with.
---

# Browser Bridge

A local CLI (`bridge`) drives the user's logged-in Chrome through an MV3
extension over a WebSocket on `127.0.0.1:8787`. It returns live page content as
**clean Markdown** (plus links and contact info), so you read tidy text instead
of parsing HTML. It also has LinkedIn-specific scrapers.

Project: `~/Developer/linkedin-bridge`. Run the CLI as `bridge <cmd>` if linked,
otherwise `node ~/Developer/linkedin-bridge/dist-cli/cli/index.js <cmd>`.

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
| `bridge act '<json>'` · `click`/`fill`/`select`/`check`/`press`/`navigate` | Drive the page |
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
             {"action":"click","target":"e5"}]'   # returns a fresh snapshot
```

Full step-by-step versions live in the reference files — read the one that fits:
- [references/recipes.md](references/recipes.md) — lead-gen pipeline, crawling, LinkedIn.
- [references/control.md](references/control.md) — the snapshot→act loop, full action
  schema, tabs, and screenshots-to-agent. **Read this before driving forms/buttons.**

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
