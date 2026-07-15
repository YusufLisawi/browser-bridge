/**
 * Capture hook — runs in the page's MAIN world at document_start while a
 * monitor session is armed. Wraps console.*, window error events, fetch and
 * XMLHttpRequest, buffering into `window.__bbCapture`. The CLI reads that
 * buffer back via an injected reader (see bbReadCapture in background.ts).
 *
 * This is the NON-CDP capture path: no chrome.debugger, no "being debugged"
 * banner. Fidelity limits: only app-level fetch/XHR (not static resource
 * loads), and only events after this hook installs (reload to catch page load).
 */
;(() => {
  const w = window as unknown as { __bbCapture?: unknown }
  if (w.__bbCapture) return
  const MAX = 500
  const cap = { logs: [] as unknown[], network: [] as unknown[], startedAt: Date.now() }
  w.__bbCapture = cap

  const push = (arr: unknown[], item: unknown) => {
    arr.push(item)
    if (arr.length > MAX) arr.shift()
  }
  const ser = (args: unknown[]) =>
    args
      .map((x) => {
        if (typeof x === "string") return x
        try {
          return JSON.stringify(x)
        } catch {
          return String(x)
        }
      })
      .join(" ")

  const con = console as unknown as Record<string, (...a: unknown[]) => unknown>
  ;(["log", "info", "warn", "error", "debug"] as const).forEach((level) => {
    const orig = con[level]
    if (typeof orig !== "function") return
    con[level] = function (this: unknown, ...args: unknown[]) {
      push(cap.logs, { level, text: ser(args).slice(0, 2000), t: Date.now() })
      return orig.apply(this, args)
    }
  })

  window.addEventListener("error", (e: ErrorEvent) => {
    push(cap.logs, {
      level: "error",
      text: "Uncaught: " + (e.message || "") + (e.filename ? ` @ ${e.filename}:${e.lineno}` : ""),
      t: Date.now(),
    })
  })
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    push(cap.logs, { level: "error", text: "Unhandled rejection: " + String(e.reason), t: Date.now() })
  })

  const bodyOf = async (res: Response): Promise<string | undefined> => {
    try {
      const ct = res.headers.get("content-type") || ""
      if (!/json|text|xml|javascript|html/i.test(ct)) return undefined
      return (await res.clone().text()).slice(0, 4000)
    } catch {
      return undefined
    }
  }

  const origFetch = window.fetch
  if (origFetch) {
    window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
      const input = args[0] as RequestInfo | URL
      const init = args[1]
      const url = String(
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url ?? input
      ).slice(0, 600)
      const method = (init?.method || (input as Request)?.method || "GET").toUpperCase()
      const t0 = Date.now()
      try {
        const res = await origFetch.apply(this as never, args)
        push(cap.network, { type: "fetch", method, url, status: res.status, ms: Date.now() - t0, t: t0, body: await bodyOf(res) })
        return res
      } catch (err) {
        push(cap.network, { type: "fetch", method, url, status: 0, error: String(err), ms: Date.now() - t0, t: t0 })
        throw err
      }
    }
  }

  const XO = window.XMLHttpRequest
  if (XO) {
    const open = XO.prototype.open
    const send = XO.prototype.send
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    XO.prototype.open = function (this: any, method: string, url: string) {
      this.__bb = { method: String(method).toUpperCase(), url: String(url).slice(0, 600), t: Date.now() }
      return open.apply(this, arguments as never)
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    XO.prototype.send = function (this: any) {
      const meta = this.__bb as { method: string; url: string; t: number } | undefined
      if (meta) {
        this.addEventListener("loadend", () => {
          let body: string | undefined
          try {
            if (this.responseType === "" || this.responseType === "text")
              body = String(this.responseText || "").slice(0, 4000)
          } catch {
            /* opaque */
          }
          push(cap.network, { type: "xhr", method: meta.method, url: meta.url, status: this.status, ms: Date.now() - meta.t, t: meta.t, body })
        })
      }
      return send.apply(this, arguments as never)
    }
  }
})()
