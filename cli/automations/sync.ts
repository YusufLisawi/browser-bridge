import { randomUUID } from "node:crypto"
import type { StoredAutomation } from "../../shared/protocol.js"
import { dispatch } from "../server.js"
import { listAutomations, loadRecipe } from "./store.js"
import { resolveSites } from "./sites.js"
import type { Recipe } from "./types.js"

export function toStoredAutomation(name: string, recipe: Recipe): StoredAutomation {
  return {
    name,
    description: recipe.description,
    sites: resolveSites(recipe),
    recipe,
    updatedAt: Date.now(),
  }
}

/** Best-effort push of one automation into the extension popup library. */
export async function syncAutomationToExtension(name: string): Promise<void> {
  const { recipe } = loadRecipe(name)
  const automation = toStoredAutomation(name, recipe)
  const r = await dispatch(
    { id: randomUUID(), kind: "automations", op: "upsert", automation },
    {
      onWaiting: () => process.stderr.write("Waiting for the extension to sync automations…\n"),
      timeoutMs: 30000,
    }
  )
  if (!r.ok) throw new Error(r.error)
}

export async function unsyncAutomationFromExtension(name: string): Promise<void> {
  const r = await dispatch(
    { id: randomUUID(), kind: "automations", op: "delete", name },
    {
      onWaiting: () => process.stderr.write("Waiting for the extension to sync automations…\n"),
      timeoutMs: 30000,
    }
  )
  if (!r.ok) throw new Error(r.error)
}

/** Push every local automation into the extension library. */
export async function syncAllAutomationsToExtension(): Promise<number> {
  const list = listAutomations()
  if (!list.length) {
    await dispatch(
      { id: randomUUID(), kind: "automations", op: "clear" },
      { timeoutMs: 30000 }
    )
    return 0
  }
  // Upsert one-by-one on a long session would be nicer; dispatchBatch works.
  const { createSession } = await import("../server.js")
  const session = await createSession({
    onWaiting: () => process.stderr.write("Waiting for the extension to sync automations…\n"),
  })
  try {
    for (const a of list) {
      const { recipe } = loadRecipe(a.name)
      const automation = toStoredAutomation(a.name, recipe)
      const r = await session.send({
        id: randomUUID(),
        kind: "automations",
        op: "upsert",
        automation,
      })
      if (!r.ok) throw new Error(r.error)
    }
    return list.length
  } finally {
    session.close()
  }
}
