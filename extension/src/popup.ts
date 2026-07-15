/**
 * Popup: bridge health, recent activity, and site-grouped automations with Run.
 */

interface JobEntry {
  kind: string
  ok: boolean
  detail: string
  at: number
}

interface StoredAutomation {
  name: string
  description?: string
  sites: string[]
  recipe: unknown
  updatedAt: number
}

interface AutoRunState {
  status: "idle" | "running" | "done" | "failed" | "cancelled"
  name?: string
  step?: string
  log?: string[]
  error?: string
  summary?: string
  cancel?: boolean
}

const KEYS = [
  "wsConnected",
  "wsConnectedAt",
  "offscreenBootedAt",
  "offscreenReadyAt",
  "offscreenError",
  "wsLastError",
  "jobHistory",
  "lastJobAt",
  "lastJobKind",
  "lastJobOk",
  "monitorActive",
  "automations",
  "autoRun",
]

function ago(ts?: number): string {
  if (!ts) return "never"
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 5) return "just now"
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const $ = (id: string) => document.getElementById(id)!

function groupBySite(list: StoredAutomation[]): Map<string, StoredAutomation[]> {
  const map = new Map<string, StoredAutomation[]>()
  for (const a of list) {
    const sites = a.sites?.length ? a.sites : ["general"]
    for (const site of sites) {
      const key = site || "general"
      const arr = map.get(key) || []
      if (!arr.some((x) => x.name === a.name)) arr.push(a)
      map.set(key, arr)
    }
  }
  return new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

function renderAutos(list: StoredAutomation[], run: AutoRunState) {
  const root = $("autos")
  const runbox = $("runbox")

  if (!list.length) {
    root.innerHTML = `<div class="empty">No automations synced yet.</div>`
  } else {
    root.innerHTML = ""
    const grouped = groupBySite(list)
    for (const [site, items] of grouped) {
      const box = document.createElement("div")
      box.className = "site"
      const h = document.createElement("div")
      h.className = "site-h"
      h.textContent = site
      box.appendChild(h)
      for (const a of items) {
        const row = document.createElement("div")
        row.className = "auto"
        const info = document.createElement("div")
        info.className = "info"
        const name = document.createElement("div")
        name.className = "name"
        name.textContent = a.name
        name.title = a.name
        const desc = document.createElement("div")
        desc.className = "desc"
        desc.textContent = a.description || "—"
        desc.title = a.description || ""
        info.append(name, desc)

        const busy = run.status === "running"
        if (busy && run.name === a.name) {
          const cancel = document.createElement("button")
          cancel.className = "cancel"
          cancel.type = "button"
          cancel.textContent = "Stop"
          cancel.onclick = () => {
            void chrome.runtime.sendMessage({ type: "auto-cancel" })
          }
          row.append(info, cancel)
        } else {
          const btn = document.createElement("button")
          btn.className = "run"
          btn.type = "button"
          btn.textContent = "Run"
          btn.disabled = busy
          btn.onclick = () => {
            btn.disabled = true
            btn.textContent = "…"
            void chrome.runtime
              .sendMessage({ type: "auto-run", name: a.name })
              .then(() => render())
              .catch(() => render())
          }
          row.append(info, btn)
        }
        box.appendChild(row)
      }
      root.appendChild(box)
    }
  }

  if (run.status === "running" || run.status === "done" || run.status === "failed" || run.status === "cancelled") {
    runbox.style.display = "block"
    const tone =
      run.status === "running" ? "Running" : run.status === "done" ? "Done" : run.status === "cancelled" ? "Cancelled" : "Failed"
    const detail = run.status === "running" ? run.step || "…" : run.summary || run.error || ""
    runbox.innerHTML = `<div class="ttl">${tone}: ${run.name || ""}</div><div class="step">${detail || ""}</div>`
  } else {
    runbox.style.display = "none"
    runbox.innerHTML = ""
  }
}

async function render() {
  const s = await chrome.storage.local.get(KEYS)
  const dot = $("dot")
  const label = $("label")
  const sub = $("sub")
  const err = $("err")

  if (s.offscreenError) {
    dot.className = "dot bad"
    label.textContent = "Extension error"
    sub.textContent = "Try reloading the extension"
    err.style.display = "block"
    err.textContent = String(s.offscreenError)
  } else if (s.wsConnected) {
    dot.className = "dot ok live"
    label.textContent = "Active"
    sub.textContent = "Running a command…"
    err.style.display = "none"
  } else if (s.offscreenBootedAt) {
    dot.className = "dot ok"
    label.textContent = "Bridge ready"
    sub.textContent = "Listening for bridge commands"
    err.style.display = "none"
  } else {
    dot.className = "dot warn"
    label.textContent = "Starting…"
    sub.textContent = "Booting the connection layer"
    err.style.display = "none"
  }

  const tabs = await chrome.tabs.query({})
  const linkedin = tabs.filter((t) => /(\/\/|\.)linkedin\.com/.test(t.url ?? "")).length
  $("tab").textContent = linkedin
    ? `LinkedIn · ${linkedin} open`
    : `${tabs.length} tab${tabs.length === 1 ? "" : "s"}`

  $("last").textContent = s.lastJobKind
    ? `${s.lastJobOk ? "✓" : "✗"} ${s.lastJobKind} · ${ago(s.lastJobAt)}`
    : "—"

  const cap = $("capture")
  cap.textContent = s.monitorActive ? "● on (console + network)" : "off"
  cap.style.color = s.monitorActive ? "var(--ok)" : "var(--muted)"

  const map = s.automations && typeof s.automations === "object" ? s.automations : {}
  const autos = Object.values(map as Record<string, StoredAutomation>)
  const run = (s.autoRun as AutoRunState) || { status: "idle" }
  renderAutos(autos, run)

  const feed = $("feed")
  const history: JobEntry[] = Array.isArray(s.jobHistory) ? s.jobHistory : []
  const feedCount = $("feedCount")
  feedCount.textContent = history.length ? `(${history.length})` : ""
  if (!history.length) {
    feed.innerHTML = '<li class="empty">No commands yet.</li>'
  } else {
    feed.innerHTML = ""
    for (const j of history) {
      const li = document.createElement("li")
      li.className = "job"
      const mark = document.createElement("span")
      mark.className = `mark ${j.ok ? "ok" : "bad"}`
      mark.textContent = j.ok ? "✓" : "✗"
      const kind = document.createElement("span")
      kind.className = "kind"
      kind.textContent = j.kind
      const detail = document.createElement("span")
      detail.className = "detail"
      detail.textContent = j.detail || ""
      detail.title = j.detail || ""
      const when = document.createElement("span")
      when.className = "when"
      when.textContent = ago(j.at)
      li.append(mark, kind, detail, when)
      feed.appendChild(li)
    }
  }
}

void render()
chrome.storage.onChanged.addListener(render)
setInterval(render, 2000)
