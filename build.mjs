/**
 * esbuild config: bundles the extension TypeScript into a plain unpacked
 * MV3 extension under extension/dist/. No framework runtime — just bundled JS
 * plus copied static assets (manifest, html). Load extension/dist/ unpacked.
 */
import * as esbuild from "esbuild"
import { cp, mkdir, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(fileURLToPath(import.meta.url))
const srcDir = resolve(root, "extension/src")
const argValue = (flag) => {
  const i = process.argv.indexOf(flag)
  return i === -1 ? undefined : process.argv[i + 1]
}
// `--out extension/dist-search` + BRIDGE_WS_PORT build a second copy for
// another browser (e.g. Search) that dials its own CLI port.
const outDir = resolve(root, argValue("--out") ?? "extension/dist")
const wsPort = process.env.BRIDGE_WS_PORT ? Number(process.env.BRIDGE_WS_PORT) : undefined
if (wsPort !== undefined && !(Number.isInteger(wsPort) && wsPort > 0 && wsPort < 65536)) {
  throw new Error(`Invalid BRIDGE_WS_PORT="${process.env.BRIDGE_WS_PORT}"`)
}
const watch = process.argv.includes("--watch")

const entryPoints = {
  background: resolve(srcDir, "background.ts"),
  offscreen: resolve(srcDir, "offscreen.ts"),
  content: resolve(srcDir, "content.ts"),
  popup: resolve(srcDir, "popup.ts"),
  capture: resolve(srcDir, "capture.ts"),
}

const staticAssets = [
  ["extension/manifest.json", "manifest.json"],
  ["extension/offscreen.html", "offscreen.html"],
  ["extension/popup.html", "popup.html"],
]

async function copyStatic() {
  for (const [from, to] of staticAssets) {
    await cp(resolve(root, from), resolve(outDir, to))
  }
}

const buildOptions = {
  entryPoints,
  outdir: outDir,
  bundle: true,
  format: "iife",
  target: ["chrome114"],
  platform: "browser",
  sourcemap: true,
  logLevel: "info",
  define: wsPort === undefined ? {} : { __BRIDGE_WS_PORT__: String(wsPort) },
}

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

if (watch) {
  const ctx = await esbuild.context(buildOptions)
  await ctx.watch()
  await copyStatic()
  console.log("[build] watching extension/src ...")
} else {
  await esbuild.build(buildOptions)
  await copyStatic()
  console.log(`[build] extension built -> ${outDir}${wsPort ? ` (port ${wsPort})` : ""}`)
}
