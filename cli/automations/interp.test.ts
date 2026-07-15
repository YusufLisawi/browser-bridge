import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { evalExpr, interpolate } from "./interp.js"

describe("interpolate", () => {
  it("replaces full-string placeholders with raw values", () => {
    const ctx = { vars: { rows: [1, 2] }, input: { limit: 5 } }
    assert.deepEqual(interpolate("${vars.rows}", ctx), [1, 2])
    assert.equal(interpolate("${input.limit}", ctx), 5)
  })

  it("interpolates inside strings and objects", () => {
    const ctx = { vars: { deleted: 3 }, input: {}, row: { href: "/x" } }
    assert.equal(interpolate("Deleted ${vars.deleted}", ctx), "Deleted 3")
    assert.deepEqual(interpolate({ url: "${row.href}" }, ctx), { url: "/x" })
  })

  it("throws on missing paths", () => {
    assert.throws(() => interpolate("${vars.missing}", { vars: {} }), /missing/)
  })
})

describe("evalExpr", () => {
  it("does arithmetic and path access", () => {
    const ctx = { vars: { deleted: 3 }, input: { limit: 10 } }
    assert.equal(evalExpr("vars.deleted + 1", ctx), 4)
    assert.equal(evalExpr("vars.deleted < input.limit", ctx), true)
    assert.equal(evalExpr('vars.deleted == 3 && input.limit > 5', ctx), true)
  })

  it("handles strings and unary not", () => {
    assert.equal(evalExpr('"a" + "b"', {}), "ab")
    assert.equal(evalExpr("!false", {}), true)
  })
})
