import { homedir } from "node:os"
import { join } from "node:path"

/** Override with BRIDGE_HOME for tests / alternate installs. */
export function bridgeHome(): string {
  return process.env.BRIDGE_HOME?.trim() || join(homedir(), ".browser-bridge")
}

export function automationsDir(): string {
  return join(bridgeHome(), "automations")
}

export function automationDir(name: string): string {
  return join(automationsDir(), name)
}

export function runsDir(): string {
  return join(bridgeHome(), "runs")
}

export function runPath(id: string): string {
  return join(runsDir(), `${id}.json`)
}

export function runCancelPath(id: string): string {
  return join(runsDir(), `${id}.cancel`)
}
