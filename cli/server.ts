/**
 * Ephemeral WebSocket server. The extension's offscreen document is the
 * CLIENT (with auto-reconnect), so each CLI invocation just stands up a server,
 * waits for the extension to connect, dispatches one Job, awaits its result,
 * then shuts down. No daemon to manage.
 */

import { WebSocketServer, type WebSocket } from "ws"
import { WS_HOST, WS_PORT, type Job, type JobResult } from "../shared/protocol.js"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface DispatchOptions {
  timeoutMs?: number
  /** Called once the extension connects, before the job is sent. */
  onConnect?: () => void
  /** Called if no client has connected yet (waiting hint). */
  onWaiting?: () => void
}

export function dispatch(job: Job, opts: DispatchOptions = {}): Promise<JobResult> {
  const timeoutMs = opts.timeoutMs ?? 180000
  return new Promise((resolve, reject) => {
    let settled = false
    const wss = new WebSocketServer({ host: WS_HOST, port: WS_PORT })

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(waitHint)
      wss.close()
      fn()
    }

    const timer = setTimeout(
      () => finish(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for a result.`))),
      timeoutMs
    )
    const waitHint = setTimeout(() => opts.onWaiting?.(), 2500)

    wss.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        finish(() =>
          reject(
            new Error(
              `Port ${WS_PORT} is already in use — another 'bridge' command may be running. ` +
                `Wait for it to finish and retry.`
            )
          )
        )
      } else {
        finish(() => reject(err))
      }
    })

    wss.on("connection", (ws: WebSocket) => {
      opts.onConnect?.()
      ws.send(JSON.stringify(job))
      ws.on("message", (data) => {
        let result: JobResult
        try {
          result = JSON.parse(data.toString()) as JobResult
        } catch {
          return
        }
        if (result.id === job.id) finish(() => resolve(result))
      })
    })
  })
}

export interface BatchOptions {
  /** Per-job timeout. */
  timeoutMs?: number
  /** Pause between jobs (human-like + rate friendly). */
  betweenMs?: number
  onConnect?: () => void
  onWaiting?: () => void
  /** Called as each job resolves, in order. */
  onResult?: (result: JobResult, job: Job, index: number) => void
}

/**
 * Run many jobs over a SINGLE connection, strictly sequentially (the jobs share
 * one browser tab, so they must not overlap). Resolves with results in order.
 */
export function dispatchBatch(jobs: Job[], opts: BatchOptions = {}): Promise<JobResult[]> {
  const timeoutMs = opts.timeoutMs ?? 180000
  const betweenMs = opts.betweenMs ?? 0
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: WS_HOST, port: WS_PORT })
    const results: JobResult[] = []
    let started = false
    const waitHint = setTimeout(() => opts.onWaiting?.(), 2500)

    const cleanup = () => {
      clearTimeout(waitHint)
      try {
        wss.close()
      } catch {
        /* ignore */
      }
    }

    wss.on("error", (err: NodeJS.ErrnoException) => {
      cleanup()
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`Port ${WS_PORT} is in use — another 'bridge' command may be running.`)
          : err
      )
    })

    const sendOne = (ws: WebSocket, job: Job): Promise<JobResult> =>
      new Promise((res, rej) => {
        const timer = setTimeout(() => {
          ws.off("message", onMsg)
          rej(new Error(`Timed out after ${timeoutMs}ms on job ${job.id}`))
        }, timeoutMs)
        const onMsg = (data: Buffer) => {
          let r: JobResult
          try {
            r = JSON.parse(data.toString()) as JobResult
          } catch {
            return
          }
          if (r.id === job.id) {
            clearTimeout(timer)
            ws.off("message", onMsg)
            res(r)
          }
        }
        ws.on("message", onMsg)
        ws.send(JSON.stringify(job))
      })

    wss.on("connection", async (ws: WebSocket) => {
      if (started) return // ignore reconnections mid-batch
      started = true
      clearTimeout(waitHint)
      opts.onConnect?.()
      try {
        for (let i = 0; i < jobs.length; i += 1) {
          const result = await sendOne(ws, jobs[i])
          results.push(result)
          opts.onResult?.(result, jobs[i], i)
          if (betweenMs && i < jobs.length - 1) await sleep(betweenMs)
        }
        cleanup()
        resolve(results)
      } catch (err) {
        cleanup()
        reject(err)
      }
    })
  })
}
