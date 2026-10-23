# Browser Bridge — Install Guide

You received a private copy of **Browser Bridge**: a local CLI (`bridge`) plus a
Chrome extension that lets you drive your own logged-in browser from the terminal.

> **Private software.** Do not redistribute this zip or publish it publicly.

## Requirements

- **macOS or Linux** (Windows may work but is untested)
- **Node.js 20+** — check with `node -v`
- **Google Chrome** (or Chromium)

## Quick setup (~2 minutes)

### Option A — Install script (when the GitHub repo is public)

```bash
curl -fsSL https://raw.githubusercontent.com/YusufLisawi/browser-bridge/main/install.sh | bash
```

Update later:

```bash
curl -fsSL https://raw.githubusercontent.com/YusufLisawi/browser-bridge/main/install.sh | bash -s -- update
```

The script refuses to run while the repo is private. Until then, use the zip
(Option B below).

### Option B — Zip (works while the repo is private)

### 1. Unzip

```bash
unzip browser-bridge-v*.zip -d ~/Developer
cd ~/Developer/browser-bridge
```

Use any folder you like; `~/Developer/browser-bridge` matches the docs.

### 2. Install dependencies

```bash
npm install
```

The zip already includes pre-built `dist-cli/` and `extension/dist/`. Rebuild
only if you change source code:

```bash
npm run build
```

### 3. Put `bridge` on your PATH

```bash
mkdir -p ~/.local/bin
ln -sfn "$PWD/dist-cli/cli/index.js" ~/.local/bin/bridge
```

Make sure `~/.local/bin` is on your `$PATH` (add to `~/.zshrc` if needed):

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Verify:

```bash
bridge --help
```

### 4. Load the Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/dist` folder inside this project
5. Click the extension → **Site access** → set **On all sites**

### 5. Test the connection

Keep Chrome open, then in a terminal:

```bash
bridge ping
```

Expected output:

```
✓ Extension connected and responding.
```

If it hangs on "Waiting for the extension to connect…", see
[skill/references/troubleshooting.md](skill/references/troubleshooting.md).

## Usage

```bash
bridge read "https://example.com" --out page.md
bridge snapshot
bridge tabs
```

Full command reference: [README.md](README.md) and [skill/SKILL.md](skill/SKILL.md).

## Updating

When you get a newer zip, replace the folder (or unzip over it), run
`npm install`, and reload the extension in `chrome://extensions`.

## LinkedIn / account risk

LinkedIn scraping violates their Terms of Service. Use low volume only, on
accounts you can afford to lose. See the warning in [README.md](README.md).
