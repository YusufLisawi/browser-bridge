# Browser Bridge

A local CLI (`bridge`) that drives your **own logged-in** browser through a
vanilla MV3 Chrome extension, over a local WebSocket. Read any URL as clean
**Markdown**, follow links, **snapshot** a page's interactive elements and
**act** on them (click/fill/select/scroll), capture **screenshots**, run
**arbitrary JS** in a page (`bridge eval` — the "do anything" primitive), or use
the built-in **LinkedIn** helpers (people search + profile scrape). Designed so
an agent reads tidy Markdown instead of parsing raw HTML, and can script
end-to-end browser automations.

```
  terminal:  bridge read "https://example.com/article"
                │
   WS :8787 ◄───┘
      │
  ┌───┴───────────────────────────────────────────────────┐
  │ Extension                                               │
  │  offscreen.js  — holds the WebSocket (reconnects)       │
  │  background.js — drives a tab, extracts content/links   │
  │  content.js    — LinkedIn-specific scrapers             │
  └─────────────────────────────────────────────────────────┘
```

## ⚠️ Read this first — account / site risk

For LinkedIn (and any site with anti-automation), this **violates their Terms of
Service**. Human-like pacing **reduces velocity-based flags but does not defeat
detection** — synthetic events are `isTrusted: false` and the OS cursor doesn't
move. **The only real protection is low volume.** The CLI enforces conservative
caps for LinkedIn (30 profiles/day, 10 searches/hour) and *refuses* to exceed
them. Generic `read`/`crawl` aren't capped — pace them yourself. Keep the repo
private and don't run this on an account you can't afford to lose.

## Setup

```bash
cd ~/Developer/browser-bridge
npm install
npm run build          # builds CLI -> dist-cli, extension -> extension/dist
# put `bridge` on your PATH (no npm needed):
ln -sfn "$PWD/dist-cli/cli/index.js" ~/.local/bin/bridge
```

Load the extension:

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `extension/dist`.
3. Stay logged into whatever sites you want to read (it uses your real session).

## Usage

```bash
bridge ping                                  # verify the extension is connected

# Generic — any site → Markdown
bridge read "https://example.com/article"
bridge read "https://a.com" "https://b.com" --out pages.md   # bulk
bridge read --file urls.txt --out pages.json --links
bridge crawl "https://docs.site.com" --limit 15 --same-host --out docs.json

# Drive a page — see it, then act on it
bridge navigate "https://example.com/login" --tab active
bridge snapshot                              # interactive elements → refs e1,e2…
bridge act '[{"action":"fill","target":"e1","text":"jane@co.com"},
             {"action":"click","target":"e5"},
             {"action":"waitForUrl","target":"/dashboard"}]'
bridge scroll bottom

# Run any JS in the page (the "do anything" primitive)
bridge eval 'return document.title'
bridge eval --file scrape.js --tab active --json --out data.json
bridge eval 'return arg.x * 2' --arg '{"x":21}'

# Automations — reusable recipes (learn once, run unattended)
bridge auto save demo-loop --file examples/automations/demo-loop/recipe.json --force
bridge auto run demo-loop                          # --wait by default
bridge auto run delete-rows --var limit=20 --detach
bridge auto status                                 # latest run
# See skill/references/automations.md

# LinkedIn helpers
bridge search "react developer berlin" --pages 2
bridge profile "https://www.linkedin.com/in/some-slug"
bridge profiles --file leads.txt --out leads.json
```

### Automations

Save repetitive flows (foreach + waits + retries) under
`~/.browser-bridge/automations/`. Agents write a recipe after figuring out the
flow once, then `bridge auto run` with `--wait` or `--detach`. Details:
[skill/references/automations.md](skill/references/automations.md).

Flags: `--pages N` (search) · `--file PATH` · `--limit N` / `--same-host` (crawl)
· `--links` (read) · `--json` · `--out FILE` (`.json` → JSON, else Markdown).
LinkedIn caps via `BRIDGE_MAX_PROFILES_PER_DAY` / `BRIDGE_MAX_SEARCHES_PER_HOUR`.

`bridge probe` / `bridge probe-profile <url>` dump live DOM structure — handy
when LinkedIn changes markup and selectors in `extension/src/lib/scrape-*.ts`
need re-tuning.

### How it connects

Each `bridge` command starts a one-shot WebSocket **server** on `127.0.0.1:8787`.
The extension is the **client** and reconnects automatically, so just keep
Chrome open — no daemon to run. Generic reads use a dedicated background "bridge
tab" so they don't disturb your active tab.

## Development

```bash
npm run watch:ext     # rebuild extension on change (reload it in chrome://extensions)
npm run typecheck
```

## Maintenance note

LinkedIn's 2024+ redesign uses fully hashed CSS class names, so scrapers anchor
on **structure** instead: `[role="list"]` + profile-link cards for search, and
`section[aria-label="Primary content"]` + leaf-text-line parsing for profiles.
These will still need occasional updates when LinkedIn shifts markup — use
`lk probe` / `lk probe-profile <url>` to dump the live DOM and re-tune
`extension/src/lib/scrape-*.ts`. Brittle fields return `null` rather than
failing the whole job.

Reused (adapted, Plasmo/zustand stripped) from the `gain-booster` project:
`dom-helpers`, human pacing, LinkedIn selectors, session scoping.
