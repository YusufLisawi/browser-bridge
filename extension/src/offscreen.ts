/**
 * Offscreen document: owns the persistent WebSocket to the local CLI server.
 *
 * IMPORTANT: an offscreen document may only use chrome.runtime MESSAGING —
 * other chrome.* APIs (chrome.storage, chrome.tabs, ...) are NOT available
 * here and touching them throws and kills the script. So we report all state
 * to the service worker via runtime messages; the SW persists them.
 */

import { WS_URL, type Job, type JobResult } from "../../shared/protocol"

let socket: WebSocket | null = null
let attempt = 0
const MAX_BACKOFF = 8000
/** Bound how long we wait for the SW to finish a job (CLI default is longer). */
const JOB_RELAY_TIMEOUT_MS = 60000
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label} timed out after ${ms}ms — reload Browser Bridge in chrome://extensions, then retry`
          )
        ),
      ms
    )
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/** Serialize WS → SW jobs so concurrent messages never overlap. */
let relayChain: Promise<unknown> = Promise.resolve()

function enqueueRelay<T>(fn: () => Promise<T>): Promise<T> {
  const run = relayChain.then(fn)
  relayChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

async function relayJob(job: Job): Promise<JobResult> {
  try {
    const result = await withTimeout(
      chrome.runtime.sendMessage({ type: "job", job }) as Promise<JobResult>,
      JOB_RELAY_TIMEOUT_MS,
      `job.${job.kind}`
    )
    // sendMessage can return undefined if the SW never responded.
    if (result == null) {
      return {
        id: job.id,
        ok: false,
        error:
          "No response from extension background — reload Browser Bridge in chrome://extensions, then retry",
      }
    }
    return result
  } catch (err) {
    return {
      id: job.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
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

  socket.addEventListener("message", (event) => {
    let job: Job
    try {
      job = JSON.parse(event.data as string)
    } catch {
      return
    }
    void enqueueRelay(async () => {
      const result = await relayJob(job)
      try {
        socket?.send(JSON.stringify(result))
      } catch {
        /* socket closed mid-job */
      }
    })
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
