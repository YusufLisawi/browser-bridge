import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"
import { runAutomation } from "./engine.js"
import { loadRecipe, newRunId, saveAutomation, writeRun } from "./store.js"
import type { RunState } from "./types.js"
import { validateRecipe } from "./validate.js"

describe("validateRecipe", () => {
  it("accepts a minimal recipe", () => {
    const v = validateRecipe({
      name: "demo",
      steps: [{ action: "log", message: "hi" }],
    })
    assert.equal(v.ok, true)
  })

  it("rejects unknown actions", () => {
    const v = validateRecipe({
      name: "bad",
      steps: [{ action: "explode" }],
    })
    assert.equal(v.ok, false)
  })
})

describe("engine foreach (no browser)", () => {
  const prevHome = process.env.BRIDGE_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), "bridge-auto-"))
    process.env.BRIDGE_HOME = home
  })

  after(() => {
    if (prevHome === undefined) delete process.env.BRIDGE_HOME
    else process.env.BRIDGE_HOME = prevHome
  })

  it("runs foreach + set + log", async () => {
    const recipePath = join(home, "demo.json")
    writeFileSync(
      recipePath,
      JSON.stringify(
        {
          name: "demo-loop",
          description: "offline foreach smoke",
          vars: { deleted: 0, rows: [{ id: 1 }, { id: 2 }, { id: 3 }] },
          steps: [
            {
              foreach: "${vars.rows}",
              as: "row",
              steps: [
                { action: "log", message: "row ${row.id}" },
                { action: "set", var: "deleted", expr: "vars.deleted + 1" },
              ],
            },
          ],
          onComplete: { summary: "Deleted ${vars.deleted} rows" },
        },
        null,
        2
      )
    )
    saveAutomation("demo-loop", { recipeFile: recipePath, force: true })
    const { recipe, hooksPath } = loadRecipe("demo-loop")
    const run: RunState = {
      id: newRunId(),
      automation: "demo-loop",
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      step: null,
      vars: {},
      input: {},
      log: [],
      error: null,
      summary: null,
    }
    writeRun(run)
    const result = await runAutomation({
      recipe,
      run,
      input: {},
      tab: "active",
      hooksPath,
      send: null,
    })
    assert.equal(result.status, "done")
    assert.equal(result.vars.deleted, 3)
    assert.match(result.summary || "", /Deleted 3/)
  })
})
