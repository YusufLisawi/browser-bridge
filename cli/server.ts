/**
 * WebSocket bridge to the extension. The offscreen document is the CLIENT
 * (auto-reconnect). Each CLI command stands up a server on 127.0.0.1:<port>
 * (default WS_PORT = 38471).
 *
 * Multi-agent safety (two layers):
 *   1. Exclusive lock file ~/.browser-bridge/bridge.lock — fair queue across agents
 *   2. Port bind wait/retry — defense in depth if the lock was stale/missing
 *
 * Agents take turns; they never drive the browser in parallel.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  type PathLike,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { WebSocketServer, type WebSocket } from "ws"
import {
  WS_HOST,
  WS_PORT,
  type Job,
  type JobResult,
} from "../shared/protocol.js"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** CLI port: BRIDGE_WS_PORT overrides the shared default (extension must match at build time). */
function resolveWsPort(): number {
  const raw = process.env.BRIDGE_WS_PORT
  if (raw == null || raw === "") return WS_PORT
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid BRIDGE_WS_PORT="${raw}" (expected 1–65535)`)
  }
  return n
}

const BRIDGE_DIR = join(homedir(), ".browser-bridge")
const LOCK_PATH = join(BRIDGE_DIR, "bridge.lock")
const HOLDER_PATH = join(BRIDGE_DIR, "holder.json")
const DEFAULT_PORT_WAIT_MS = 180_000
const LOCK_RETRY_MS = 350
const PORT_RETRY_MS = 400
/** Treat a lock as stale if the PID is dead, or the lock is older than this. */
const STALE_LOCK_MS = 30 * 60 * 1000

type LockHandle = { fd: number; release: () => void }

function ensureBridgeDir(): void {
  try {
    mkdirSync(BRIDGE_DIR, { recursive: true })
  } catch {
    /* best-effort */
  }
}

function readHolder(): { pid: number; at: number; port: number; argv?: string } | null {
  try {
    if (!existsSync(HOLDER_PATH)) return null
    const raw = JSON.parse(readFileSync(HOLDER_PATH, "utf8")) as {
      pid?: number
      at?: number
      port?: number
      argv?: string
    }
    if (typeof raw.pid !== "number") return null
    return {
      pid: raw.pid,
      at: typeof raw.at === "number" ? raw.at : 0,
      port: typeof raw.port === "number" ? raw.port : WS_PORT,
      argv: typeof raw.argv === "string" ? raw.argv : undefined,
    }
  } catch {
    return null
  }
}

function writeHolder(port: number): void {
  try {
    const argv = process.argv.slice(2).join(" ").slice(0, 120)
    writeFileSync(
      HOLDER_PATH,
      JSON.stringify({ pid: process.pid, at: Date.now(), port, argv }, null, 0) + "\n"
    )
  } catch {
    /* best-effort */
  }
}

function clearHolder(): void {
  try {
    unlinkSync(HOLDER_PATH)
  } catch {
    /* ignore */
  }
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // EPERM = process exists but we can't signal it
    return code === "EPERM"
  }
}

function tryRemoveStaleLock(path: PathLike): boolean {
  try {
    const text = readFileSync(path, "utf8")
    const [pidStr, atStr] = text.split("\n")
    const pid = Number(pidStr)
    const at = Number(atStr)
    const agedOut = Number.isFinite(at) && at > 0 && Date.now() - at > STALE_LOCK_MS
    if ((!pidAlive(pid) && Number.isFinite(pid)) || agedOut) {
      unlinkSync(path)
      return true
    }
  } catch {
    try {
      unlinkSync(path)
      return true
    } catch {
      /* still locked */
    }
  }
  return false
}

function portBusyError(port: number, waitedMs: number): Error {
  const holder = readHolder()
  const who =
    holder && pidAlive(holder.pid)
      ? ` (held by pid ${holder.pid}${holder.argv ? `: bridge ${holder.argv}` : ""})`
      : ""
  return new Error(
    `Port ${port} is still in use after waiting ${Math.round(waitedMs / 1000)}s` +
      `${who} — another 'bridge' command is still running. ` +
      `Wait for it to finish, or check with: lsof -ti:${port}`
  )
}

const defaultPortBusy = () => {
  const holder = readHolder()
  const detail =
    holder && pidAlive(holder.pid)
      ? ` (queued behind pid ${holder.pid}${holder.argv ? `: ${holder.argv}` : ""})`
      : ""
  process.stderr.write(`Waiting for another bridge command to finish…${detail}\n`)
}

function portWaitMs(): number {
  const raw = process.env.BRIDGE_PORT_WAIT_MS
  if (raw == null || raw === "") return DEFAULT_PORT_WAIT_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PORT_WAIT_MS
}

/**
 * Acquire an exclusive lock so concurrent agents queue fairly before binding the port.
 */
async function acquireLock(waitMs: number, onWaiting?: () => void): Promise<LockHandle> {
  ensureBridgeDir()
  const deadline = Date.now() + waitMs
  let hinted = false

  while (true) {
    try {
      const fd = openSync(LOCK_PATH, "wx")
      writeFileSync(fd, `${process.pid}\n${Date.now()}\n`)
      return {
        fd,
        release() {
          try {
            closeSync(fd)
          } catch {
            /* ignore */
          }
          try {
            unlinkSync(LOCK_PATH)
          } catch {
            /* ignore */
          }
          clearHolder()
        },
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== "EEXIST") throw err
      if (tryRemoveStaleLock(LOCK_PATH)) continue
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        const holder = readHolder()
        throw new Error(
          `Timed out after ${Math.round(waitMs / 1000)}s waiting for the bridge lock` +
            (holder?.pid ? ` (held by pid ${holder.pid})` : "") +
            `. Another agent is still using bridge.`
        )
      }
      if (!hinted) {
        hinted = true
        onWaiting?.()
      }
      await sleep(Math.min(LOCK_RETRY_MS, remaining))
    }
  }
}

export interface SessionOptions {
  /** Called once the extension connects. */
  onConnect?: () => void
  /** Called if no client has connected yet (waiting hint). */
  onWaiting?: () => void
  /** Called when another bridge process holds the lock/port (multi-agent queue). */
  onPortBusy?: () => void
  /** Max ms to wait for the first extension connection (default 120s). */
  connectTimeoutMs?: number
  /** Max ms to wait for the lock + port (default 180s, env BRIDGE_PORT_WAIT_MS). */
  portWaitMs?: number
}

export interface Session {
  send(job: Job, timeoutMs?: number): Promise<JobResult>
  close(): void
}

/**
 * Try to bind the WS server. On EADDRINUSE, retry until portWaitMs elapses.
 */
async function bindServer(
  port: number,
  portWait: number,
  onPortBusy?: () => void
): Promise<WebSocketServer> {
  const deadline = Date.now() + portWait
  let hinted = false

  while (true) {
    try {
      const wss = await new Promise<WebSocketServer>((resolve, reject) => {
        const server = new WebSocketServer({ host: WS_HOST, port })
        const onError = (err: NodeJS.ErrnoException) => {
          server.off("listening", onListening)
          try {
            server.close()
          } catch {
            /* ignore */
          }
          reject(err)
        }
        const onListening = () => {
          server.off("error", onError)
          resolve(server)
        }
        server.once("error", onError)
        server.once("listening", onListening)
      })
      return wss
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== "EADDRINUSE") throw err
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw portBusyError(port, portWait)
      if (!hinted) {
        hinted = true
        onPortBusy?.()
      }
      await sleep(Math.min(PORT_RETRY_MS, remaining))
    }
  }
}

/**
 * Bind the WS server and wait for the extension. Keep the socket open across
 * many `send()` calls until `close()`.
 */
export async function createSession(opts: SessionOptions = {}): Promise<Session> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 120000
  const waitBudget = opts.portWaitMs ?? portWaitMs()
  const onPortBusy = opts.onPortBusy ?? defaultPortBusy
  const port = resolveWsPort()

  const lock = await acquireLock(waitBudget, onPortBusy)
  let wss: WebSocketServer
  try {
    wss = await bindServer(port, waitBudget, onPortBusy)
  } catch (err) {
    lock.release()
    throw err
  }
  writeHolder(port)

  return new Promise((resolve, reject) => {
    let settled = false
    let ws: WebSocket | null = null
    let closed = false
    const waitHint = setTimeout(() => opts.onWaiting?.(), 2500)

    const cleanup = () => {
      lock.release()
    }

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
      cleanup()
      reject(err)
    }

    const connectTimer = setTimeout(
      () => fail(new Error(`Timed out after ${connectTimeoutMs}ms waiting for the extension to connect.`)),
      connectTimeoutMs
    )

    wss.on("error", (err: NodeJS.ErrnoException) => {
      fail(err)
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
              rej(
                new Error(
                  `Timed out after ${timeoutMs}ms on job ${job.id}` +
                    (job.kind === "snapshot" || job.kind === "screenshot" || job.kind === "act"
                      ? ` — if tabs/navigate still work, reload Browser Bridge in chrome://extensions, then retry`
                      : "")
                )
              )
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
          cleanup()
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
          cleanup()
        }
      })

      resolve(session)
    })
  })
}

export interface DispatchOptions {
  timeoutMs?: number
  portWaitMs?: number
  onConnect?: () => void
  onWaiting?: () => void
  onPortBusy?: () => void
}

export async function dispatch(job: Job, opts: DispatchOptions = {}): Promise<JobResult> {
  const session = await createSession({
    onConnect: opts.onConnect,
    onWaiting: opts.onWaiting,
    onPortBusy: opts.onPortBusy,
    portWaitMs: opts.portWaitMs,
  })
  try {
    return await session.send(job, opts.timeoutMs ?? 180000)
  } finally {
    session.close()
  }
}

export interface BatchOptions {
  timeoutMs?: number
  betweenMs?: number
  portWaitMs?: number
  onConnect?: () => void
  onWaiting?: () => void
  onPortBusy?: () => void
  onResult?: (result: JobResult, job: Job, index: number) => void
}

/**
 * Run many jobs over a SINGLE connection, strictly sequentially.
 */
export async function dispatchBatch(jobs: Job[], opts: BatchOptions = {}): Promise<JobResult[]> {
  const timeoutMs = opts.timeoutMs ?? 180000
  const betweenMs = opts.betweenMs ?? 0
  const session = await createSession({
    onConnect: opts.onConnect,
    onWaiting: opts.onWaiting,
    onPortBusy: opts.onPortBusy,
    portWaitMs: opts.portWaitMs,
  })
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
