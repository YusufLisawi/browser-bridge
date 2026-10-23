#!/usr/bin/env node
/**
 * Build browser-bridge and pack a shareable zip (source + pre-built CLI + extension).
 * Output: releases/browser-bridge-v<version>.zip
 */
import { execSync } from "node:child_process"
import { readFile, mkdir, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
const version = pkg.version
const outDir = join(root, "releases")
const zipName = `browser-bridge-v${version}.zip`
const zipPath = join(outDir, zipName)

console.log(`[release] building v${version}...`)
execSync("npm run build", { cwd: root, stdio: "inherit" })

await mkdir(outDir, { recursive: true })

// zip from project root; exclude dev junk, keep pre-built dist-cli + extension/dist
const excludes = [
  "node_modules/*",
  ".git/*",
  "releases/*",
  "*.log",
  ".DS_Store",
]

execSync(
  `zip -r "${zipPath}" . ${excludes.map((e) => `-x "${e}"`).join(" ")}`,
  { cwd: root, stdio: "inherit" },
)

const { size } = await stat(zipPath)
const sizeMb = (size / 1024 / 1024).toFixed(2)
console.log(`\n[release] created ${zipPath} (${sizeMb} MB)`)
console.log(`[release] share this zip with friends — see INSTALL.md inside`)
