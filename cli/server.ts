/**
 * WebSocket bridge to the extension. The offscreen document is the CLIENT
 * (auto-reconnect). Each CLI command stands up a server on 127.0.0.1:8787.
 *
 * - `dispatch` / `dispatchBatch` — one-shot helpers (close after work)
 * - `createSession` — long-lived connection for automation runs
 */

import { WebSocketServer, type WebSocket } from "ws"
import { WS_HOST, WS_PORT, type Job, type JobResult } from "../shared/protocol.js"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const portInUseError = () =>
  new Error(
    `Port ${WS_PORT} is already in use — another 'bridge' command may be running. ` +
      `Wait for it to finish and retry.`
  )

export interface SessionOptions {
  /** Called once the extension connects. */
  onConnect?: () => void
  /** Called if no client has connected yet (waiting hint). */
  onWaiting?: () => void
  /** Max ms to wait for the first extension connection (default 120s). */
  connectTimeoutMs?: number
}

export interface Session {
  send(job: Job, timeoutMs?: number): Promise<JobResult>
  close(): void
}

/**
 * Bind the WS server and wait for the extension. Keep the socket open across
 * many `send()` calls until `close()`.
 */
export function createSession(opts: SessionOptions = {}): Promise<Session> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 120000

  return new Promise((resolve, reject) => {
    let settled = false
    let ws: WebSocket | null = null
    let closed = false
    const wss = new WebSocketServer({ host: WS_HOST, port: WS_PORT })
    const waitHint = setTimeout(() => opts.onWaiting?.(), 2500)

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(waitHint)
      clearTimeout(connectTimer)
      try {
        wss.close()
      } catch {
        /* ignore */
      }
      reject(err)
    }

    const connectTimer = setTimeout(
      () => fail(new Error(`Timed out after ${connectTimeoutMs}ms waiting for the extension to connect.`)),
      connectTimeoutMs
    )

    wss.on("error", (err: NodeJS.ErrnoException) => {
      fail(err.code === "EADDRINUSE" ? portInUseError() : err)
    })

    wss.on("connection", (socket: WebSocket) => {
      // Ignore reconnections; only the first client drives the session.
      if (ws) return
      ws = socket
      settled = true
      clearTimeout(waitHint)
      clearTimeout(connectTimer)
      opts.onConnect?.()

      const session: Session = {
        send(job, timeoutMs = 180000) {
          if (closed || !ws || ws.readyState !== ws.OPEN) {
            return Promise.reject(new Error("Session is closed."))
          }
          const sock = ws
          return new Promise<JobResult>((res, rej) => {
            const timer = setTimeout(() => {
              sock.off("message", onMsg)
              rej(new Error(`Timed out after ${timeoutMs}ms on job ${job.id}`))
            }, timeoutMs)
            const onMsg = (data: WebSocket.RawData) => {
              let r: JobResult
              try {
                r = JSON.parse(data.toString()) as JobResult
              } catch {
                return
              }
              if (r.id === job.id) {
                clearTimeout(timer)
                sock.off("message", onMsg)
                res(r)
              }
            }
            sock.on("message", onMsg)
            sock.send(JSON.stringify(job))
          })
        },
        close() {
          if (closed) return
          closed = true
          try {
            ws?.close()
          } catch {
            /* ignore */
          }
          try {
            wss.close()
          } catch {
            /* ignore */
          }
        },
      }

      socket.on("close", () => {
        if (!closed) {
          closed = true
          try {
            wss.close()
          } catch {
            /* ignore */
          }
        }
      })

      resolve(session)
    })
  })
}

export interface DispatchOptions {
  timeoutMs?: number
  onConnect?: () => void
  onWaiting?: () => void
}

export async function dispatch(job: Job, opts: DispatchOptions = {}): Promise<JobResult> {
  const session = await createSession(opts)
  try {
    return await session.send(job, opts.timeoutMs ?? 180000)
  } finally {
    session.close()
  }
}

export interface BatchOptions {
  timeoutMs?: number
  betweenMs?: number
  onConnect?: () => void
  onWaiting?: () => void
  onResult?: (result: JobResult, job: Job, index: number) => void
}

/**
 * Run many jobs over a SINGLE connection, strictly sequentially.
 */
export async function dispatchBatch(jobs: Job[], opts: BatchOptions = {}): Promise<JobResult[]> {
  const timeoutMs = opts.timeoutMs ?? 180000
  const betweenMs = opts.betweenMs ?? 0
  const session = await createSession(opts)
  const results: JobResult[] = []
  try {
    for (let i = 0; i < jobs.length; i += 1) {
      const result = await session.send(jobs[i], timeoutMs)
      results.push(result)
      opts.onResult?.(result, jobs[i], i)
      if (betweenMs && i < jobs.length - 1) await sleep(betweenMs)
    }
    return results
  } finally {
    session.close()
  }
}
