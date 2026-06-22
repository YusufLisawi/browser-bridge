# Browser Bridge — Recipes

Detailed workflows. SKILL.md has the quick versions; read this for the full
pipelines and edge handling.

## Contents
- Lead generation (search → sites → contacts → sheet)
- Reading & crawling patterns
- LinkedIn sourcing & enrichment
- Output shapes

## Lead generation pipeline

Goal: from a niche + location, produce a sheet of businesses with contact info.

1. **Search.** Build a Google query and read the SERP as JSON. Add more pages
   with `&start=10`, `&start=20` for depth — issue them in one bulk `read`:
   ```bash
   bridge read \
     "https://www.google.com/search?q=interior+design+firms+austin+tx" \
     "https://www.google.com/search?q=interior+design+firms+austin+tx&start=10" \
     --json --out serp.json
   ```

2. **Extract lead sites.** Run the bundled script — it decodes Google/DDG
   redirect links, drops search-engine/social/infra domains, dedupes by host,
   and prints homepages:
   ```bash
   node ~/.claude/skills/browser-bridge/scripts/leads.mjs serp.json > leads.txt
   node ~/.claude/skills/browser-bridge/scripts/leads.mjs serp.json --names   # preview with business names
   ```
   Review `leads.txt`; trim aggregators (yelp/houzz/etc.) if you want only
   direct business sites.

3. **Enrich.** Read each lead site — contacts come from the whole page:
   ```bash
   bridge read --file leads.txt --json --out leads.json
   ```
   For sites that bury contact info on a dedicated page, also read `/contact`
   (append those URLs to `leads.txt`, or crawl `--same-host --limit 10`).

4. **Build the sheet.** Each `leads.json` entry is
   `{ url, title, markdown, links, contacts }`. Map to rows:
   `name=title`, `website=url`, `emails=contacts.emails`,
   `phones=contacts.phones`, `socials=contacts.socials`, and a short summary
   from `markdown`. Export to CSV/XLSX as the user prefers.

Tips:
- Contacts can be empty if a site renders contact info only after interaction or
  hides it behind a form. Fall back to reading `/contact`, `/about`, `/team`.
- De-dupe across runs by domain. Keep a master list and skip hosts already seen.
- Pace large batches; `read` already pauses ~1.5s between bulk items.

## Reading & crawling

- **Single vs bulk:** one URL → single fetch; multiple URLs or `--file` → one
  socket, sequential. Always prefer bulk over shell loops.
- **`crawl <url>`** reads the start page, takes its links (optionally
  `--same-host`), follows up to `--limit` (default 20), returns Markdown for the
  start page + each link. Good for docs sites, link hubs, sitemaps.
- **`--out` format:** `.json` writes an array of page objects; any other
  extension writes concatenated Markdown (`# title` + `<url>` + body, separated
  by `---`). Use `.json` when you need `links`/`contacts`; `.md` for reading.
- **`--links`** (read, stdout/markdown mode) appends the page's link list.

## LinkedIn

- **People search:** `bridge search "<keywords>" --pages N` → array of
  `{ name, headline, location, profileUrl, connectionDegree }`. Pages dedupe by
  profile URL. Refine queries for precision (`"real estate" broker austin` beats
  `owner austin`).
- **Single profile:** `bridge profile <url|slug|name>`. A name is resolved by
  searching and taking the top hit. Returns one-page data only:
  `name, headline, location, followers, connections, currentCompany,
  currentSchool, latestPost{text,time}`. No experience/education list — the new
  LinkedIn UI doesn't render those on the first page.
- **Bulk profiles:** `bridge profiles <url>… --file f --out leads.json`. One
  socket, sequential, ~4s pacing, daily-cap aware (scrapes up to the remaining
  cap and warns about the rest). Each result is `{ ok, kind, profile }` or
  `{ ok:false, error }`.
- **Source → enrich chain:** `search --json --out people.json`, extract
  `profileUrl`s into a file, then `profiles --file`.

## Output shapes (for parsing)

`read`/`crawl` page object:
```json
{ "url": "...", "title": "...", "markdown": "...",
  "links": [{ "href": "...", "text": "..." }],
  "contacts": { "emails": [], "phones": [], "socials": [] } }
```
`profile` object:
```json
{ "profileUrl": "...", "name": "...", "headline": "...", "location": "...",
  "followers": 1234, "connections": "500+ connections",
  "currentCompany": "...", "currentSchool": "...",
  "latestPost": { "text": "...", "time": "2w" } }
```
