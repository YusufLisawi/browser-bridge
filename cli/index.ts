#!/usr/bin/env node
/**
 * `lk` — drive a logged-in LinkedIn tab from the terminal via the extension.
 *
 *   bridge ping
 *   bridge search "react developer berlin" [--pages 2] [--json] [--out file.json]
 *   bridge profile <url|slug|name> [--deep] [--json] [--out file.json]
 */

import { randomUUID } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import TurndownService from "turndown"
import type { ActionStep, Job, JobResult, SnapNode, TabTarget } from "../shared/protocol.js"
import { dispatch, dispatchBatch } from "./server.js"
import { assertWithinLimit, recordUsage, remainingFor } from "./ratelimit.js"
import { handleAutomation } from "./automations/commands.js"

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
})
const toMarkdown = (html: string): string => turndown.turndown(html || "").trim()

interface Flags {
  pages: number
  deep: boolean
  json: boolean
  out: string | null
  file: string | null
  limit: number
  sameHost: boolean
  links: boolean
  tab: TabTarget
  noSnapshot: boolean
  continueOnError: boolean
  human: boolean
  clear: boolean
  arg: string | null
  timeout: number | null
  positional: string[]
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {
    pages: 1,
    deep: false,
    json: false,
    out: null,
    file: null,
    limit: 20,
    sameHost: false,
    links: false,
    tab: "bridge",
    noSnapshot: false,
    continueOnError: false,
    human: false,
    clear: false,
    arg: null,
    timeout: null,
    positional: [],
  }
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === "--pages") flags.pages = Math.max(1, parseInt(args[++i] ?? "1", 10) || 1)
    else if (a === "--deep") flags.deep = true
    else if (a === "--json") flags.json = true
    else if (a === "--out") flags.out = args[++i] ?? null
    else if (a === "--file") flags.file = args[++i] ?? null
    else if (a === "--limit") flags.limit = Math.max(1, parseInt(args[++i] ?? "20", 10) || 20)
    else if (a === "--same-host") flags.sameHost = true
    else if (a === "--links") flags.links = true
    else if (a === "--tab") flags.tab = args[++i] ?? "bridge"
    else if (a === "--no-snapshot") flags.noSnapshot = true
    else if (a === "--continue-on-error") flags.continueOnError = true
    else if (a === "--human") flags.human = true
    else if (a === "--clear") flags.clear = true
    else if (a === "--arg") flags.arg = args[++i] ?? null
    else if (a === "--timeout") flags.timeout = parseInt(args[++i] ?? "", 10) || null
    else flags.positional.push(a)
  }
  return flags
}

/** Gather targets from positional args + an optional --file (one per line). */
function collectTargets(flags: Flags): string[] {
  const targets = [...flags.positional]
  if (flags.file) {
    const content = readFileSync(flags.file, "utf8")
    targets.push(...content.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")))
  }
  return [...new Set(targets.map((t) => t.trim()).filter(Boolean))]
}

const log = (s = "") => process.stdout.write(s + "\n")

function printHelp() {
  log(`bridge — Browser Bridge CLI

Usage:
  bridge ping                                  Check the extension is connected
  bridge read <url> [<url> ...] [--file f]     Fetch any page(s) as Markdown
  bridge read --tab active                     Read the page you're currently on
  bridge crawl <url> [--limit N] [--same-host] Read a page, follow its links → Markdown

  Tabs & capture:
  bridge tabs                                  List open tabs (id, title, url)
  bridge tab activate|close <id>               Focus or close a tab
  bridge tab new <url>                         Open a new tab
  bridge screenshot [--tab x] [--out f.png]    Save a PNG of a tab (agent reads the file)

  Control (drive forms/buttons; default the background bridge tab, --tab <active|id>):
  bridge navigate <url>                        Point the tab at a URL
  bridge snapshot                              List interactive elements (refs e1,e2…)
  bridge act '<json>'                          Run action(s): {"action","target","text",…}
  bridge click <ref|sel>                       Click an element
  bridge fill <ref|sel> <text>                 Type into an input/textarea
  bridge select <ref|sel> <value>              Pick a <select> option
  bridge check|uncheck <ref|sel>               Toggle a checkbox/radio
  bridge press <key> [ref|sel]                 Press a key (Enter, Tab, Escape…)
  bridge scroll [top|bottom|<px>] [--human]    Scroll (--human = jittered multi-step)
  bridge move <ref|sel> | <x> <y>              Move the mouse (human path) to a target

  Scripting (run any JS — the "do anything" primitive):
  bridge eval '<js>' [--tab x] [--arg json]    Run JS in the page; 'return' a value
  bridge eval --file script.js [--timeout ms]  Run a JS file (async + await supported)

  Capture (console + network, no debugger banner):
  bridge monitor start|stop|status             Arm/disarm console + network capture
  bridge logs [--tab x] [--clear]              Show captured console logs + errors
  bridge network [--tab x] [--clear]           Show captured fetch/XHR requests

  Automations (reusable recipes — alias: bridge auto):
  bridge automation list|show|save|delete      Manage ~/.browser-bridge/automations
  bridge automation run <name> [--wait|--detach] [--var k=v]
  bridge automation status|wait|cancel|runs    Inspect / await background runs

  LinkedIn:
  bridge search <query...> [--pages N]         People-search results
  bridge profile <url|slug|name>               One profile (first page)
  bridge profiles <url> <url> ... [--file f]   Many profiles in bulk

Options:
  --tab active  control: act on your active tab instead of the bridge tab
  --no-snapshot control: skip the after-action snapshot
  --continue-on-error  act: keep running steps after one fails (default: stop)
  --human       click/scroll/move: simulate human pacing (jittered motion + delays)
  --clear       logs/network: clear the buffer after reading
  --arg JSON    eval: value exposed to the script as 'arg' (JSON or string)
  --timeout MS  eval: max time to await an async result (default 15000)
  --pages N     search: number of result pages (default 1)
  --file PATH   profiles/read: read targets from a file (one per line, # = comment)
  --limit N     crawl: max links to follow (default 20)
  --same-host   crawl: only follow links on the start page's host
  --links       read: also list the page's links
  --json        Print raw JSON instead of a summary
  --out FILE    Write result(s) to FILE (.json = JSON, else Markdown)

Make sure Chrome is open, the extension is loaded, and you are logged in.`)
}

function emit(result: JobResult, flags: Flags) {
  if (flags.out) {
    writeFileSync(flags.out, JSON.stringify(result, null, 2))
    log(`Wrote ${flags.out}`)
  }
  if (flags.json || flags.out) {
    if (flags.json) log(JSON.stringify(result, null, 2))
    return
  }
  if (!result.ok) {
    log(`✗ Error: ${result.error}`)
    return
  }
  if (result.kind === "ping") {
    log("✓ Extension connected and responding.")
  } else if (result.kind === "probe") {
    log(JSON.stringify(result.data, null, 2))
  } else if (result.kind === "search") {
    log(`✓ ${result.hits.length} result(s):\n`)
    result.hits.forEach((h, i) => {
      log(`${i + 1}. ${h.name ?? "(no name)"}${h.connectionDegree ? ` · ${h.connectionDegree}` : ""}`)
      if (h.headline) log(`   ${h.headline}`)
      if (h.location) log(`   ${h.location}`)
      if (h.profileUrl) log(`   ${h.profileUrl}`)
      log()
    })
  } else if (result.kind === "profile") {
    const p = result.profile
    log(`✓ ${p.name ?? "(no name)"}`)
    if (p.headline) log(`  ${p.headline}`)
    if (p.currentCompany) log(`  Company: ${p.currentCompany}`)
    if (p.currentSchool) log(`  School:  ${p.currentSchool}`)
    if (p.location) log(`  ${p.location}`)
    if (p.followers != null) log(`  Followers: ${p.followers.toLocaleString()}`)
    if (p.connections) log(`  ${p.connections}`)
    if (p.latestPost) {
      const t = p.latestPost.time ? ` (${p.latestPost.time} ago)` : ""
      log(`\n  Latest post${t}:`)
      log(`   ${(p.latestPost.text ?? "").slice(0, 300)}${(p.latestPost.text?.length ?? 0) > 300 ? "…" : ""}`)
    }
    log(`\n  ${p.profileUrl ?? ""}`)
  }
}

/** Bulk profile scrape: one socket, jobs run sequentially with pacing. */
async function runProfiles(flags: Flags): Promise<void> {
  let targets = [...flags.positional]
  if (flags.file) {
    const content = readFileSync(flags.file, "utf8")
    targets.push(
      ...content.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    )
  }
  targets = [...new Set(targets.map((t) => t.trim()).filter(Boolean))]
  if (!targets.length) throw new Error("Provide profile urls/slugs as args or via --file <path>.")

  const remaining = remainingFor("profile")
  if (remaining <= 0) {
    throw new Error("Daily profile cap reached. Try tomorrow or raise BRIDGE_MAX_PROFILES_PER_DAY.")
  }
  if (targets.length > remaining) {
    process.stderr.write(
      `⚠ Daily cap allows ${remaining} more; scraping the first ${remaining} of ${targets.length}.\n`
    )
    targets = targets.slice(0, remaining)
  }

  const jobs: Job[] = targets.map((target) => ({
    id: randomUUID(),
    kind: "profile" as const,
    target,
    deep: false,
  }))

  process.stderr.write(`Scraping ${jobs.length} profile(s)…\n`)
  const results = await dispatchBatch(jobs, {
    betweenMs: 4000,
    onWaiting: () => process.stderr.write("Waiting for the extension to connect…\n"),
    onResult: (r, jb, i) => {
      if (r.ok) recordUsage("profile")
      const target = jb.kind === "profile" ? jb.target : ""
      const label =
        r.ok && r.kind === "profile"
          ? r.profile.name ?? target
          : `ERROR: ${r.ok === false ? r.error : ""}`
      process.stderr.write(`[${i + 1}/${jobs.length}] ${r.ok ? "✓" : "✗"} ${label}\n`)
    },
  })

  if (flags.out) {
    writeFileSync(flags.out, JSON.stringify(results, null, 2))
    log(`\nWrote ${results.length} result(s) to ${flags.out}`)
  }
  if (flags.json) {
    log(JSON.stringify(results, null, 2))
  } else if (!flags.out) {
    log("")
    for (const r of results) {
      if (r.ok && r.kind === "profile") {
        const p = r.profile
        log(`• ${p.name ?? "(no name)"} — ${p.headline ?? ""}`)
        log(`  ${[p.currentCompany, p.location].filter(Boolean).join(" · ")}` +
          (p.followers != null ? ` · ${p.followers.toLocaleString()} followers` : ""))
        if (p.latestPost?.text)
          log(`  latest (${p.latestPost.time ?? "?"}): ${p.latestPost.text.slice(0, 120)}…`)
        log(`  ${p.profileUrl ?? ""}`)
      } else if (!r.ok) {
        log(`• ✗ ${r.error}`)
      }
    }
  }

  const failed = results.filter((r) => !r.ok).length
  process.exit(failed === results.length && results.length > 0 ? 1 : 0)
}

interface Page {
  url: string
  title: string
  markdown: string
  links: { href: string; text: string }[]
  contacts: { emails: string[]; phones: string[]; socials: string[] }
  error?: string
}

const NO_CONTACTS = { emails: [], phones: [], socials: [] }

function pagesFrom(results: JobResult[]): Page[] {
  return results.map((r) =>
    r.ok && r.kind === "read"
      ? {
          url: r.page.url,
          title: r.page.title,
          markdown: toMarkdown(r.page.html),
          links: r.page.links,
          contacts: r.page.contacts,
        }
      : {
          url: "",
          title: "",
          markdown: "",
          links: [],
          contacts: NO_CONTACTS,
          error: r.ok ? "unexpected result" : r.error,
        }
  )
}

function emitPages(results: JobResult[], flags: Flags): void {
  const pages = pagesFrom(results)
  if (flags.out) {
    if (flags.out.endsWith(".json")) {
      writeFileSync(flags.out, JSON.stringify(pages, null, 2))
    } else {
      writeFileSync(
        flags.out,
        pages
          .map((p) => (p.error ? `<!-- ERROR: ${p.error} -->` : `# ${p.title}\n\n<${p.url}>\n\n${p.markdown}`))
          .join("\n\n---\n\n")
      )
    }
    log(`Wrote ${pages.length} page(s) to ${flags.out}`)
  }
  if (flags.json) {
    log(JSON.stringify(pages, null, 2))
    return
  }
  if (flags.out) return
  pages.forEach((p, i) => {
    if (i) log("\n---\n")
    if (p.error) {
      log(`✗ ${p.error}`)
      return
    }
    log(`# ${p.title}\n<${p.url}>\n`)
    const c = p.contacts
    if (c.emails.length || c.phones.length || c.socials.length) {
      log("## Contacts")
      if (c.emails.length) log(`- Emails: ${c.emails.join(", ")}`)
      if (c.phones.length) log(`- Phones: ${c.phones.join(", ")}`)
      if (c.socials.length) log(`- Socials: ${c.socials.join(", ")}`)
      log("")
    }
    log(p.markdown)
    if (flags.links && p.links.length) {
      log(`\n## Links (${p.links.length})`)
      p.links.slice(0, 200).forEach((l) => log(`- [${l.text || l.href}](${l.href})`))
    }
  })
}

const onWaiting = () => process.stderr.write("Waiting for the extension to connect…\n")

/** bridge read <url...> — fetch page(s) as Markdown. With no URL, read the
 *  resolved tab's current page (e.g. `bridge read --tab active`). */
async function runRead(flags: Flags): Promise<void> {
  const urls = collectTargets(flags)
  const jobs: Job[] = urls.length
    ? urls.map((url) => ({ id: randomUUID(), kind: "read" as const, url }))
    : [{ id: randomUUID(), kind: "read" as const, tab: flags.tab }]
  if (jobs.length > 1) process.stderr.write(`Reading ${jobs.length} page(s)…\n`)
  const results = await dispatchBatch(jobs, {
    betweenMs: 1500,
    onWaiting,
    onResult: (r, jb, i) => {
      if (jobs.length > 1)
        process.stderr.write(
          `[${i + 1}/${jobs.length}] ${r.ok ? "✓" : "✗"} ${jb.kind === "read" ? jb.url ?? "(current tab)" : ""}\n`
        )
    },
  })
  emitPages(results, flags)
  process.exit(results.length > 0 && results.every((r) => !r.ok) ? 1 : 0)
}

/** bridge crawl <url> — read a page, follow its links, return Markdown for each. */
async function runCrawl(flags: Flags): Promise<void> {
  const start = flags.positional[0]
  if (!start) throw new Error("Provide a start URL: bridge crawl <url>")
  process.stderr.write(`Reading start page ${start}…\n`)
  const startRes = await dispatch({ id: randomUUID(), kind: "read", url: start }, { onWaiting })
  if (!startRes.ok || startRes.kind !== "read") {
    throw new Error(startRes.ok ? "Unexpected result" : startRes.error)
  }

  let hrefs = startRes.page.links.map((l) => l.href)
  if (flags.sameHost) {
    const host = new URL(start).hostname
    hrefs = hrefs.filter((h) => {
      try {
        return new URL(h).hostname === host
      } catch {
        return false
      }
    })
  }
  const seen = new Set([start])
  const targets: string[] = []
  for (const h of hrefs) {
    if (!seen.has(h)) {
      seen.add(h)
      targets.push(h)
    }
    if (targets.length >= flags.limit) break
  }
  process.stderr.write(
    `Found ${startRes.page.links.length} link(s); following ${targets.length} ` +
      `(limit ${flags.limit}${flags.sameHost ? ", same-host" : ""})…\n`
  )

  const jobs: Job[] = targets.map((url) => ({ id: randomUUID(), kind: "read" as const, url }))
  const linkResults = jobs.length
    ? await dispatchBatch(jobs, {
        betweenMs: 1500,
        onResult: (r, jb, i) =>
          process.stderr.write(
            `[${i + 1}/${jobs.length}] ${r.ok ? "✓" : "✗"} ${jb.kind === "read" ? jb.url : ""}\n`
          ),
      })
    : []
  emitPages([startRes, ...linkResults], flags)
  process.exit(0)
}

/* --------------------------- browser control ---------------------------- */

function fmtSnapshot(els: SnapNode[]): string {
  if (!els.length) return "  (no interactive elements found)"
  return els
    .map((e) => {
      const head = e.tag + (e.type ? `(${e.type})` : "") + (e.role ? `{${e.role}}` : "")
      const bits = [`[${e.ref}]`, head]
      if (e.name) bits.push(JSON.stringify(e.name))
      if (e.value) bits.push("= " + JSON.stringify(e.value))
      if (e.checked != null) bits.push(e.checked ? "[x]" : "[ ]")
      if (e.disabled) bits.push("(disabled)")
      return "  " + bits.join(" ")
    })
    .join("\n")
}

function emitControl(r: JobResult, flags: Flags): void {
  if (flags.out) {
    writeFileSync(flags.out, JSON.stringify(r, null, 2))
    log(`Wrote ${flags.out}`)
  }
  if (flags.json) {
    log(JSON.stringify(r, null, 2))
    return
  }
  if (flags.out) return
  if (!r.ok) {
    log(`✗ ${r.error}`)
    return
  }
  if (r.kind === "monitor") {
    log(
      r.active
        ? "✓ Monitoring armed — console + network capture on.\n  Reload open pages (or navigate) to capture from page load, then `bridge logs` / `bridge network`."
        : "✓ Monitoring stopped."
    )
  } else if (r.kind === "logs") {
    log(`# logs <${r.url}> — ${r.logs.length} entr${r.logs.length === 1 ? "y" : "ies"}\n`)
    for (const l of r.logs) {
      const ts = new Date(l.t).toLocaleTimeString()
      log(`  ${ts} [${l.level}] ${l.text}`)
    }
    if (!r.logs.length) log("  (none — is `bridge monitor start` armed and the page reloaded?)")
  } else if (r.kind === "network") {
    log(`# network <${r.url}> — ${r.requests.length} request(s)\n`)
    for (const n of r.requests) {
      const status = n.status || "ERR"
      log(`  ${status} ${n.method.padEnd(4)} ${n.url}  (${n.ms}ms)${n.error ? " — " + n.error : ""}`)
    }
    if (!r.requests.length) log("  (none — is `bridge monitor start` armed and the page reloaded?)")
  } else if (r.kind === "snapshot") {
    log(`# ${r.title}\n<${r.url}>  — ${r.elements.length} interactive element(s)\n`)
    log(fmtSnapshot(r.elements))
  } else if (r.kind === "eval") {
    log(typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2))
  } else if (r.kind === "act") {
    for (const s of r.results) {
      const out = s.json !== undefined ? s.json : s.value
      const val = out != null ? ` = ${typeof out === "string" ? out : JSON.stringify(out)}` : ""
      const err = s.error ? ` — ${s.error}` : ""
      log(`${s.ok ? "✓" : "✗"} ${s.action}${s.target ? " " + s.target : ""}${val}${err}`)
    }
    if (r.snapshot) {
      log(`\nPage now <${r.url}>:`)
      log(fmtSnapshot(r.snapshot))
    }
  }
}

function fmtTabs(tabs: { id: number; active: boolean; title: string; url: string }[]): string {
  return tabs
    .map((t) => `  ${t.active ? "▸" : " "} ${String(t.id).padEnd(8)} ${t.title || "(untitled)"}\n      ${t.url}`)
    .join("\n")
}

/** Build + dispatch a single-step act job (used by the shortcut commands). */
async function runAct(actions: ActionStep[], flags: Flags): Promise<void> {
  const r = await dispatch(
    {
      id: randomUUID(),
      kind: "act",
      actions,
      tab: flags.tab,
      snapshot: !flags.noSnapshot,
      continueOnError: flags.continueOnError,
    },
    { onWaiting }
  )
  emitControl(r, flags)
  process.exit(r.ok && (r.kind !== "act" || r.results.every((s) => s.ok)) ? 0 : 1)
}

/** bridge eval — run arbitrary JS in a tab (MAIN world) and print the value. */
async function runEvalCmd(flags: Flags): Promise<void> {
  const code = flags.file ? readFileSync(flags.file, "utf8") : flags.positional.join(" ").trim()
  if (!code) throw new Error('Provide JS, e.g. bridge eval "return document.title"  (or --file script.js)')
  let arg: unknown
  if (flags.arg != null) {
    try {
      arg = JSON.parse(flags.arg)
    } catch {
      arg = flags.arg // treat as a plain string
    }
  }
  const r = await dispatch(
    {
      id: randomUUID(),
      kind: "eval",
      code,
      tab: flags.tab,
      arg,
      timeout: flags.timeout ?? undefined,
    },
    { onWaiting, timeoutMs: (flags.timeout ?? 15000) + 5000 }
  )
  if (flags.out) {
    writeFileSync(flags.out, JSON.stringify(r, null, 2))
    log(`Wrote ${flags.out}`)
  }
  if (flags.json) log(JSON.stringify(r, null, 2))
  else emitControl(r, flags)
  process.exit(r.ok ? 0 : 1)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const flags = parseFlags(rest)

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp()
    return
  }

  if (command === "automation" || command === "auto") {
    await handleAutomation(rest)
    return
  }

  if (command === "profiles") {
    await runProfiles(flags)
    return
  }
  if (command === "read") {
    await runRead(flags)
    return
  }
  if (command === "crawl") {
    await runCrawl(flags)
    return
  }
  if (command === "tabs") {
    const r = await dispatch({ id: randomUUID(), kind: "tabs", op: "list" }, { onWaiting })
    if (flags.json) log(JSON.stringify(r, null, 2))
    else if (r.ok && r.kind === "tabs") log(fmtTabs(r.tabs))
    else if (!r.ok) log(`✗ ${r.error}`)
    process.exit(r.ok ? 0 : 1)
  }
  if (command === "tab") {
    const op = flags.positional[0] as "activate" | "close" | "new"
    if (!["activate", "close", "new"].includes(op))
      throw new Error("Usage: bridge tab <activate|close|new> <id|url>")
    const arg = flags.positional[1]
    const job: Job =
      op === "new"
        ? { id: randomUUID(), kind: "tabs", op, url: arg }
        : { id: randomUUID(), kind: "tabs", op, tabId: Number(arg) }
    const r = await dispatch(job, { onWaiting })
    if (flags.json) log(JSON.stringify(r, null, 2))
    else if (r.ok && r.kind === "tabs") log(fmtTabs(r.tabs))
    else if (!r.ok) log(`✗ ${r.error}`)
    process.exit(r.ok ? 0 : 1)
  }
  if (command === "screenshot") {
    const r = await dispatch({ id: randomUUID(), kind: "screenshot", tab: flags.tab }, { onWaiting })
    if (!r.ok || r.kind !== "screenshot") {
      process.stderr.write(`✗ ${r.ok ? "unexpected result" : r.error}\n`)
      process.exit(1)
    }
    const out = flags.out || "bridge-screenshot.png"
    const b64 = r.dataUrl.replace(/^data:image\/\w+;base64,/, "")
    writeFileSync(out, Buffer.from(b64, "base64"))
    log(`Saved screenshot to ${out}  (read it with your image-read tool)`)
    process.exit(0)
  }
  if (command === "snapshot") {
    const r = await dispatch({ id: randomUUID(), kind: "snapshot", tab: flags.tab }, { onWaiting })
    emitControl(r, flags)
    process.exit(r.ok ? 0 : 1)
  }
  if (command === "act") {
    const raw = flags.positional.join(" ").trim()
    if (!raw) throw new Error('Provide actions JSON, e.g. bridge act \'[{"action":"click","target":"e7"}]\'')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error("Invalid actions JSON.")
    }
    const actions = (Array.isArray(parsed) ? parsed : [parsed]) as ActionStep[]
    await runAct(actions, flags)
    return
  }
  // Ergonomic single-action shortcuts.
  if (command === "click") {
    if (!flags.positional[0]) throw new Error("Usage: bridge click <ref|selector>")
    await runAct([{ action: "click", target: flags.positional[0], human: flags.human }], flags)
    return
  }
  if (command === "move") {
    // bridge move <ref|sel>   |   bridge move <x> <y>
    const a0 = flags.positional[0]
    if (!a0) throw new Error("Usage: bridge move <ref|selector>  or  bridge move <x> <y>")
    const x = parseInt(a0, 10)
    const y = parseInt(flags.positional[1] ?? "", 10)
    const step: ActionStep =
      flags.positional.length >= 2 && !Number.isNaN(x) && !Number.isNaN(y)
        ? { action: "mouseMove", x, y, human: true }
        : { action: "mouseMove", target: a0, human: true }
    await runAct([step], flags)
    return
  }
  if (command === "fill" || command === "type") {
    const target = flags.positional[0]
    const text = flags.positional.slice(1).join(" ")
    if (!target) throw new Error(`Usage: bridge ${command} <ref|selector> <text>`)
    await runAct([{ action: "fill", target, text }], flags)
    return
  }
  if (command === "select") {
    const target = flags.positional[0]
    const value = flags.positional.slice(1).join(" ")
    if (!target) throw new Error("Usage: bridge select <ref|selector> <value>")
    await runAct([{ action: "select", target, value }], flags)
    return
  }
  if (command === "check" || command === "uncheck") {
    if (!flags.positional[0]) throw new Error(`Usage: bridge ${command} <ref|selector>`)
    await runAct([{ action: command, target: flags.positional[0] }], flags)
    return
  }
  if (command === "press") {
    const key = flags.positional[0] || "Enter"
    await runAct([{ action: "press", key, target: flags.positional[1] }], flags)
    return
  }
  if (command === "navigate" || command === "goto") {
    const url = flags.positional[0]
    if (!url) throw new Error("Usage: bridge navigate <url>")
    await runAct([{ action: "navigate", url }], flags)
    return
  }
  if (command === "eval" || command === "exec") {
    await runEvalCmd(flags)
    return
  }
  if (command === "scroll") {
    // bridge scroll [top|bottom|<px>] [--human]
    const arg = flags.positional[0]
    const step: ActionStep =
      arg === "top" || arg === "bottom"
        ? { action: "scroll", target: arg, human: flags.human }
        : { action: "scroll", deltaY: arg ? parseInt(arg, 10) || undefined : undefined, human: flags.human }
    await runAct([step], flags)
    return
  }
  if (command === "monitor") {
    const op = (flags.positional[0] as "start" | "stop" | "status") || "status"
    if (!["start", "stop", "status"].includes(op))
      throw new Error("Usage: bridge monitor <start|stop|status>")
    const r = await dispatch({ id: randomUUID(), kind: "monitor", op }, { onWaiting })
    emitControl(r, flags)
    process.exit(r.ok ? 0 : 1)
  }
  if (command === "logs" || command === "network") {
    const r = await dispatch(
      { id: randomUUID(), kind: command as "logs" | "network", tab: flags.tab, clear: flags.clear },
      { onWaiting }
    )
    emitControl(r, flags)
    process.exit(r.ok ? 0 : 1)
  }

  let job: Job
  let usageType: "profile" | "search" | null = null

  if (command === "ping") {
    job = { id: randomUUID(), kind: "ping" }
  } else if (command === "probe") {
    const query = flags.positional.join(" ").trim() || "software engineer"
    job = { id: randomUUID(), kind: "probe", query }
  } else if (command === "probe-profile") {
    const target = flags.positional.join(" ").trim()
    if (!target) throw new Error("Provide a profile url, e.g. bridge probe-profile <url>")
    job = { id: randomUUID(), kind: "probeProfile", target }
  } else if (command === "search") {
    const query = flags.positional.join(" ").trim()
    if (!query) throw new Error("Provide a search query, e.g. bridge search \"react developer\"")
    assertWithinLimit("search")
    usageType = "search"
    job = { id: randomUUID(), kind: "search", query, pages: flags.pages }
  } else if (command === "profile") {
    const target = flags.positional.join(" ").trim()
    if (!target) throw new Error("Provide a profile url, slug, or name.")
    assertWithinLimit("profile")
    usageType = "profile"
    job = { id: randomUUID(), kind: "profile", target, deep: flags.deep }
  } else {
    throw new Error(`Unknown command "${command}". Run 'bridge help'.`)
  }

  const result = await dispatch(job, {
    onWaiting: () => process.stderr.write("Waiting for the extension to connect…\n"),
  })

  if (usageType && result.ok) recordUsage(usageType)
  emit(result, flags)
  process.exit(result.ok ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
