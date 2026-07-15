export type InterpContext = Record<string, unknown>

const PLACEHOLDER = /\$\{([^}]+)\}/g

function getPath(ctx: InterpContext, path: string): unknown {
  const parts = path.trim().split(".")
  let cur: unknown = ctx
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") {
      throw new Error(`Cannot resolve "\${${path}}" — "${p}" missing`)
    }
    if (!(p in (cur as object))) {
      throw new Error(`Cannot resolve "\${${path}}" — "${p}" missing`)
    }
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

/** Resolve a dotted path against the context (vars, input, item aliases, …). */
export function resolvePath(ctx: InterpContext, path: string): unknown {
  return getPath(ctx, path)
}

/**
 * Replace `${vars.x}` / `${input.y}` / `${row.z}` in strings.
 * Non-string values are walked recursively.
 */
export function interpolate<T>(value: T, ctx: InterpContext): T {
  if (typeof value === "string") {
    const full = value.match(/^\$\{([^}]+)\}$/)
    if (full) {
      return getPath(ctx, full[1]) as T
    }
    return value.replace(PLACEHOLDER, (_, path: string) => {
      const v = getPath(ctx, path)
      if (v == null) return ""
      return typeof v === "string" ? v : JSON.stringify(v)
    }) as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolate(v, ctx)) as T
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolate(v, ctx)
    }
    return out as T
  }
  return value
}

/* -------------------- tiny safe expression evaluator -------------------- */

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "null" }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "dot" }

function tokenize(expr: string): Tok[] {
  const s = expr.trim()
  const toks: Tok[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) {
      i += 1
      continue
    }
    if (c === "(") {
      toks.push({ t: "lp" })
      i += 1
      continue
    }
    if (c === ")") {
      toks.push({ t: "rp" })
      i += 1
      continue
    }
    if (c === ".") {
      toks.push({ t: "dot" })
      i += 1
      continue
    }
    if (c === '"' || c === "'") {
      const q = c
      let j = i + 1
      let out = ""
      while (j < s.length && s[j] !== q) {
        if (s[j] === "\\") {
          out += s[j + 1] ?? ""
          j += 2
          continue
        }
        out += s[j]
        j += 1
      }
      if (s[j] !== q) throw new Error(`Unterminated string in expr: ${expr}`)
      toks.push({ t: "str", v: out })
      i = j + 1
      continue
    }
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(s[i + 1] ?? ""))) {
      let j = i + 1
      while (j < s.length && /[0-9.]/.test(s[j])) j += 1
      toks.push({ t: "num", v: Number(s.slice(i, j)) })
      i = j
      continue
    }
    const two = s.slice(i, i + 2)
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      toks.push({ t: "op", v: two })
      i += 2
      continue
    }
    if ("+-*/<>!".includes(c)) {
      toks.push({ t: "op", v: c })
      i += 1
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j += 1
      const id = s.slice(i, j)
      if (id === "true") toks.push({ t: "bool", v: true })
      else if (id === "false") toks.push({ t: "bool", v: false })
      else if (id === "null") toks.push({ t: "null" })
      else toks.push({ t: "id", v: id })
      i = j
      continue
    }
    throw new Error(`Unexpected character "${c}" in expr: ${expr}`)
  }
  return toks
}

/**
 * Evaluate a tiny expression against ctx.
 * Supports: numbers, strings, bools, null, dotted paths (vars.x), + - * /,
 * comparisons, && ||, parentheses, unary !.
 */
export function evalExpr(expr: string, ctx: InterpContext): unknown {
  const toks = tokenize(expr)
  let i = 0

  const peek = () => toks[i]
  const eat = () => toks[i++]

  const parsePrimary = (): unknown => {
    const t = eat()
    if (!t) throw new Error(`Unexpected end of expr: ${expr}`)
    if (t.t === "num") return t.v
    if (t.t === "str") return t.v
    if (t.t === "bool") return t.v
    if (t.t === "null") return null
    if (t.t === "lp") {
      const v = parseOr()
      if (peek()?.t !== "rp") throw new Error(`Expected ")" in expr: ${expr}`)
      eat()
      return v
    }
    if (t.t === "op" && t.v === "!") return !truthy(parsePrimary())
    if (t.t === "op" && t.v === "-") return -Number(parsePrimary())
    if (t.t === "id") {
      let path = t.v
      while (peek()?.t === "dot") {
        eat()
        const n = eat()
        if (!n || n.t !== "id") throw new Error(`Expected property after "." in: ${expr}`)
        path += "." + n.v
      }
      return getPath(ctx, path)
    }
    throw new Error(`Unexpected token in expr: ${expr}`)
  }

  const parseMul = (): unknown => {
    let left = parsePrimary()
    while (peek()?.t === "op" && (peek()!.t === "op" && ["*", "/"].includes((peek() as { v: string }).v))) {
      const op = (eat() as { v: string }).v
      const right = parsePrimary()
      left = op === "*" ? Number(left) * Number(right) : Number(left) / Number(right)
    }
    return left
  }

  const parseAdd = (): unknown => {
    let left = parseMul()
    while (peek()?.t === "op" && ["+", "-"].includes((peek() as { v: string }).v)) {
      const op = (eat() as { v: string }).v
      const right = parseMul()
      if (op === "+" && (typeof left === "string" || typeof right === "string")) {
        left = String(left) + String(right)
      } else {
        left = op === "+" ? Number(left) + Number(right) : Number(left) - Number(right)
      }
    }
    return left
  }

  const parseCmp = (): unknown => {
    let left = parseAdd()
    while (
      peek()?.t === "op" &&
      ["==", "!=", "<", ">", "<=", ">="].includes((peek() as { v: string }).v)
    ) {
      const op = (eat() as { v: string }).v
      const right = parseAdd()
      if (op === "==") left = left === right
      else if (op === "!=") left = left !== right
      else if (op === "<") left = Number(left) < Number(right)
      else if (op === ">") left = Number(left) > Number(right)
      else if (op === "<=") left = Number(left) <= Number(right)
      else left = Number(left) >= Number(right)
    }
    return left
  }

  const parseAnd = (): unknown => {
    let left = parseCmp()
    while (peek()?.t === "op" && (peek() as { v: string }).v === "&&") {
      eat()
      const right = parseCmp()
      left = truthy(left) && truthy(right)
    }
    return left
  }

  const parseOr = (): unknown => {
    let left = parseAnd()
    while (peek()?.t === "op" && (peek() as { v: string }).v === "||") {
      eat()
      const right = parseAnd()
      left = truthy(left) || truthy(right)
    }
    return left
  }

  const result = parseOr()
  if (i < toks.length) throw new Error(`Trailing tokens in expr: ${expr}`)
  return result
}

export function truthy(v: unknown): boolean {
  return Boolean(v)
}
