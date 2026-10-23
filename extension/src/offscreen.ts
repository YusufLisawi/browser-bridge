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
const RECOVER_RELOAD_DELAY_MS = 100
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
            `${label} timed out after ${ms}ms — run \`bridge recover\`, then retry`
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

function sendResult(client: WebSocket, result: JobResult): void {
  try {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(result))
  } catch {
    /* socket closed mid-job */
  }
}

/** A direct control path so recovery is never stuck behind a wedged browser job. */
function recoverExtension(job: Extract<Job, { kind: "recover" }>, client: WebSocket): void {
  sendResult(client, { id: job.id, ok: true, kind: "recover" })
  setTimeout(() => {
    // Ask the service worker to reload itself. This matters when the worker's
    // browser-job queue is wedged: reloading only this offscreen page leaves
    // that in-memory queue alive in some Chromium-based browsers.
    void chrome.runtime.sendMessage({ type: "recover-extension" }).catch(() => {
      // Fallback for runtimes that cannot deliver the control message while
      // the worker is unhealthy; runtime is the only API offscreen exposes.
      try {
        chrome.runtime.reload()
      } catch {
        /* the extension may already be unloading */
      }
    })
  }, RECOVER_RELOAD_DELAY_MS)
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
          "No response from extension background — run `bridge recover`, then retry",
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "offscreen-health") return
  sendResponse({ ok: true, wsConnected: socket?.readyState === WebSocket.OPEN })
})

const connect = () => {
  let client: WebSocket
  try {
    client = new WebSocket(WS_URL)
  } catch {
    scheduleReconnect()
    return
  }
  socket = client

  client.addEventListener("open", () => {
    attempt = 0
    report({ wsConnected: true, wsLastError: null, wsConnectedAt: Date.now() })
  })

  client.addEventListener("message", (event) => {
    let job: Job
    try {
      job = JSON.parse(event.data as string)
    } catch {
      return
    }
    if (job.kind === "recover") {
      recoverExtension(job, client)
      return
    }
    void enqueueRelay(async () => {
      const result = await relayJob(job)
      sendResult(client, result)
    })
  })

  client.addEventListener("close", () => {
    if (socket === client) socket = null
    report({ wsConnected: false })
    scheduleReconnect()
  })

  client.addEventListener("error", () => {
    report({ wsConnected: false, wsLastError: `connect failed @ ${new Date().toISOString()}` })
    try {
      client.close()
    } catch {
      /* already closed */
    }
  })
}

const scheduleReconnect = () => {
  setTimeout(connect, nextDelay(attempt))
  attempt += 1
}

connect()
