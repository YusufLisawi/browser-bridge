/** Popup: shows whether the CLI WebSocket is connected and the target tab. */

async function render() {
  const dot = document.getElementById("dot")!
  const status = document.getElementById("status")!
  const tabEl = document.getElementById("tab")!

  const { wsConnected } = await chrome.storage.local.get("wsConnected")
  if (wsConnected) {
    dot.className = "dot on"
    status.textContent = "Connected to CLI"
  } else {
    dot.className = "dot off"
    status.textContent = "CLI not running"
  }

  const tabs = await chrome.tabs.query({ url: ["*://*.linkedin.com/*"] })
  tabEl.textContent = tabs.length
    ? `LinkedIn tab: ${tabs.length} open`
    : "No LinkedIn tab open"

  // Diagnostics
  const diag = document.getElementById("diag")!
  const s = await chrome.storage.local.get([
    "offscreenBootedAt",
    "offscreenReadyAt",
    "offscreenError",
    "wsLastError",
  ])
  const fmt = (t?: number) => (t ? new Date(t).toLocaleTimeString() : "never")
  diag.textContent =
    `offscreen created: ${fmt(s.offscreenReadyAt)}\n` +
    `offscreen booted: ${fmt(s.offscreenBootedAt)}\n` +
    (s.offscreenError ? `offscreen ERROR: ${s.offscreenError}\n` : "") +
    (s.wsLastError ? `last ws error: ${s.wsLastError}` : "")
}

void render()
chrome.storage.onChanged.addListener(render)
