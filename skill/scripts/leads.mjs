#!/usr/bin/env node
/**
 * Extract candidate lead sites from `bridge read --json` SERP output.
 *
 * Decodes Google (/url?q=) and DuckDuckGo (/l/?uddg=) redirect links, drops
 * search-engine / social / infra domains, dedupes by host, and prints one
 * homepage URL per line — ready to pipe into `bridge read --file`.
 *
 *   bridge read "https://www.google.com/search?q=QUERY" --json --out serp.json
 *   node leads.mjs serp.json > leads.txt
 *   bridge read --file leads.txt --out leads.json   # then read each for contacts
 *
 * Pass --names to also print the link text (business name) as a comment.
 */
import { readFileSync } from "node:fs"

const SKIP =
  /(^|\.)(google|gstatic|googleusercontent|goo\.gl|duckduckgo|bing|yahoo|youtube|facebook|fb|instagram|twitter|x|pinterest|tiktok|reddit|wikipedia|wikimedia|w3|schema|gmail|apple|microsoft|amazon|linkedin)\./i

const file = process.argv[2]
const withNames = process.argv.includes("--names")
if (!file) {
  console.error("usage: node leads.mjs <bridge-read.json> [--names]")
  process.exit(1)
}

function realUrl(href) {
  try {
    const u = new URL(href)
    if (u.hostname.includes("google.") && u.searchParams.get("q")) return u.searchParams.get("q")
    if (u.hostname.includes("duckduckgo.") && u.searchParams.get("uddg"))
      return decodeURIComponent(u.searchParams.get("uddg"))
    return href
  } catch {
    return null
  }
}

const data = JSON.parse(readFileSync(file, "utf8"))
const pages = Array.isArray(data) ? data : [data]
const seen = new Map()

for (const page of pages) {
  for (const link of page.links ?? []) {
    const real = realUrl(link.href)
    if (!real) continue
    let host
    try {
      host = new URL(real).hostname.replace(/^www\./, "")
    } catch {
      continue
    }
    if (SKIP.test(host) || seen.has(host)) continue
    seen.set(host, (link.text ?? "").replace(/\s+/g, " ").trim().slice(0, 60))
  }
}

for (const [host, name] of seen) {
  if (withNames && name) console.log(`# ${name}`)
  console.log(`https://${host}/`)
}
console.error(`# ${seen.size} candidate lead site(s)`)
