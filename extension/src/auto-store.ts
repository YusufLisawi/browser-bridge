import type { StoredAutomation } from "../../shared/protocol"

const STORAGE_KEY = "automations"
const RUN_KEY = "autoRun"

export async function listStoredAutomations(): Promise<StoredAutomation[]> {
  const { automations } = await chrome.storage.local.get(STORAGE_KEY)
  if (!automations || typeof automations !== "object") return []
  return Object.values(automations as Record<string, StoredAutomation>).sort((a, b) =>
    a.name.localeCompare(b.name)
  )
}

export async function upsertStoredAutomation(a: StoredAutomation): Promise<StoredAutomation[]> {
  const { automations } = await chrome.storage.local.get(STORAGE_KEY)
  const map = { ...(automations && typeof automations === "object" ? automations : {}) } as Record<
    string,
    StoredAutomation
  >
  map[a.name] = a
  await chrome.storage.local.set({ [STORAGE_KEY]: map })
  return Object.values(map)
}

export async function deleteStoredAutomation(name: string): Promise<StoredAutomation[]> {
  const { automations } = await chrome.storage.local.get(STORAGE_KEY)
  const map = { ...(automations && typeof automations === "object" ? automations : {}) } as Record<
    string,
    StoredAutomation
  >
  delete map[name]
  await chrome.storage.local.set({ [STORAGE_KEY]: map })
  return Object.values(map)
}

export async function clearStoredAutomations(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: {} })
}

export async function getStoredAutomation(name: string): Promise<StoredAutomation | null> {
  const list = await listStoredAutomations()
  return list.find((a) => a.name === name) ?? null
}

export type AutoRunState = {
  status: "idle" | "running" | "done" | "failed" | "cancelled"
  name?: string
  step?: string
  log?: string[]
  error?: string
  summary?: string
  cancel?: boolean
  at?: number
}

export async function setAutoRun(state: AutoRunState): Promise<void> {
  await chrome.storage.local.set({ [RUN_KEY]: state })
}

export async function getAutoRun(): Promise<AutoRunState> {
  const { autoRun } = await chrome.storage.local.get(RUN_KEY)
  return (autoRun as AutoRunState) || { status: "idle" }
}

export async function requestAutoCancel(): Promise<void> {
  const cur = await getAutoRun()
  await setAutoRun({ ...cur, cancel: true })
}
