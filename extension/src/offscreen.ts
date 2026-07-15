/**
 * Offscreen document: owns the persistent WebSocket to the local CLI server.
 *
 * IMPORTANT: an offscreen document may only use chrome.runtime MESSAGING —
 * other chrome.* APIs (chrome.storage, chrome.tabs, ...) are NOT available
 * here and touching them throws and kills the script. So we report all state
 * to the service worker via runtime messages; the SW persists it.
 */

import { WS_URL, type Job, type JobResult } from "../../shared/protocol"

let socket: WebSocket | null = null
let attempt = 0
const MAX_BACKOFF = 8000
// The CLI server only exists for the brief window a command runs, so the first
// few reconnects are fast (catch the window quickly); an idle browser then
// backs off so it isn't re-dialing a dead port forever.
const nextDelay = (n: number) => (n < 4 ? 250 : Math.min(250 * 2 ** (n - 3), MAX_BACKOFF))

/** Send a state patch to the SW (which writes it to chrome.storage). */
const report = (patch: Record<string, unknown>) => {
  try {
    void chrome.runtime.sendMessage({ type: "ws-state", patch })
  } catch {
    /* SW may be momentarily asleep; harmless */
  }
}

// Breadcrumb: proves this script actually executed.
report({ offscreenBootedAt: Date.now() })

const connect = () => {
  try {
    socket = new WebSocket(WS_URL)
  } catch {
    scheduleReconnect()
    return
  }

  socket.addEventListener("open", () => {
    attempt = 0
    report({ wsConnected: true, wsLastError: null, wsConnectedAt: Date.now() })
  })

  socket.addEventListener("message", async (event) => {
    let job: Job
    try {
      job = JSON.parse(event.data as string)
    } catch {
      return
    }
    const result: JobResult = await chrome.runtime.sendMessage({ type: "job", job })
    socket?.send(JSON.stringify(result))
  })

  socket.addEventListener("close", () => {
    report({ wsConnected: false })
    scheduleReconnect()
  })

  socket.addEventListener("error", () => {
    report({ wsConnected: false, wsLastError: `connect failed @ ${new Date().toISOString()}` })
    socket?.close()
  })
}

const scheduleReconnect = () => {
  setTimeout(connect, nextDelay(attempt))
  attempt += 1
}

connect()
