#!/usr/bin/env bash
# Browser Bridge installer — install / update the CLI + extension from GitHub.
# Only runs when the repository is public (private repos return 404 to anonymous API).
#
#   curl -fsSL https://raw.githubusercontent.com/YusufLisawi/browser-bridge/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- update
#
set -euo pipefail

REPO="YusufLisawi/browser-bridge"
REPO_URL="https://github.com/${REPO}"
RAW_BASE="https://raw.githubusercontent.com/${REPO}"
INSTALL_DIR="${BRIDGE_INSTALL_DIR:-${HOME}/.local/share/browser-bridge}"
BIN_DIR="${BRIDGE_BIN_DIR:-${HOME}/.local/bin}"
BRIDGE_BIN="${BIN_DIR}/bridge"
BRANCH="${BRIDGE_BRANCH:-main}"
VERSION="${BRIDGE_VERSION:-}"

info()  { printf '→ %s\n' "$*"; }
warn()  { printf '⚠ %s\n' "$*" >&2; }
die()   { printf '✗ %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

check_node() {
  require_cmd node
  local major
  major="$(node -pe 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 20 ]; then
    die "Node.js 20+ required (found $(node -v))"
  fi
}

# Abort unless the repo is reachable anonymously (i.e. public).
check_repo_public() {
  local meta http_code
  meta="$(mktemp)"
  trap 'rm -f "$meta"' RETURN

  http_code="$(curl -fsSL -o "$meta" -w '%{http_code}' \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/${REPO}" 2>/dev/null || true)"

  if [ "$http_code" != "200" ]; then
    die "Cannot access ${REPO_URL} (HTTP ${http_code:-unknown}).

This installer only works when the repository is public.
While the repo is private, use the zip from the maintainer (see INSTALL.md)."
  fi

  local private
  private="$(node -pe "JSON.parse(require('fs').readFileSync('${meta}','utf8')).private")"
  if [ "$private" != "false" ]; then
    die "Repository is private. Make ${REPO_URL} public before using this installer."
  fi
}

ensure_bin_dir() {
  mkdir -p "$BIN_DIR"
  case ":${PATH}:" in
    *":${BIN_DIR}:"*) ;;
    *)
      warn "${BIN_DIR} is not on your PATH."
      warn "Add this to your shell rc (~/.zshrc or ~/.bashrc):"
      warn "  export PATH=\"\${HOME}/.local/bin:\$PATH\""
      ;;
  esac
}

link_bridge() {
  ensure_bin_dir
  ln -sfn "${INSTALL_DIR}/dist-cli/cli/index.js" "$BRIDGE_BIN"
  info "Linked ${BRIDGE_BIN}"
}

build() {
  info "Installing npm dependencies…"
  (cd "$INSTALL_DIR" && npm install --no-fund --no-audit)
  info "Building CLI and extension…"
  (cd "$INSTALL_DIR" && npm run build)
}

write_meta() {
  local ver
  ver="$(node -pe "JSON.parse(require('fs').readFileSync('${INSTALL_DIR}/package.json','utf8')).version")"
  cat > "${INSTALL_DIR}/.install-meta" <<EOF
installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
repo=${REPO_URL}
branch=${BRANCH}
version=${ver}
install_dir=${INSTALL_DIR}
EOF
}

print_extension_steps() {
  cat <<EOF

✓ Browser Bridge installed.

  CLI:       ${BRIDGE_BIN}
  Source:    ${INSTALL_DIR}
  Extension: ${INSTALL_DIR}/extension/dist

Load the Chrome extension (one-time):
  1. Open chrome://extensions → enable Developer mode
  2. Load unpacked → select: ${INSTALL_DIR}/extension/dist
  3. Site access → On all sites

Test:
  bridge ping

Update later:
  curl -fsSL ${RAW_BASE}/${BRANCH}/install.sh | bash -s -- update
EOF
}

cmd_install() {
  check_repo_public
  require_cmd git
  require_cmd npm
  check_node

  if [ -d "${INSTALL_DIR}/.git" ]; then
    die "Already installed at ${INSTALL_DIR}. Run: install.sh update"
  fi

  if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]; then
    die "Install directory exists but is not a git repo: ${INSTALL_DIR}"
  fi

  mkdir -p "$(dirname "$INSTALL_DIR")"

  if [ -n "$VERSION" ]; then
    info "Cloning ${REPO_URL} (tag v${VERSION})…"
    git clone --depth 1 --branch "v${VERSION}" "https://github.com/${REPO}.git" "$INSTALL_DIR"
  else
    info "Cloning ${REPO_URL} (branch ${BRANCH})…"
    git clone --depth 1 --branch "$BRANCH" "https://github.com/${REPO}.git" "$INSTALL_DIR"
  fi

  build
  link_bridge
  write_meta
  print_extension_steps
}

cmd_update() {
  check_repo_public
  require_cmd git
  require_cmd npm
  check_node

  [ -d "${INSTALL_DIR}/.git" ] || die "Not installed. Run: install.sh install"

  info "Updating ${INSTALL_DIR}…"
  (
    cd "$INSTALL_DIR"
    git fetch --depth 1 origin "$BRANCH"
    git checkout "$BRANCH"
    git pull --ff-only origin "$BRANCH"
  )

  build
  link_bridge
  write_meta
  info "✓ Updated to $(node -pe "JSON.parse(require('fs').readFileSync('${INSTALL_DIR}/package.json','utf8')).version")"
  warn "Reload the extension in chrome://extensions if extension files changed."
}

cmd_status() {
  if [ -f "${INSTALL_DIR}/.install-meta" ]; then
    cat "${INSTALL_DIR}/.install-meta"
  elif [ -d "${INSTALL_DIR}/.git" ]; then
    info "Installed at ${INSTALL_DIR} (no .install-meta)"
    info "version=$(node -pe "JSON.parse(require('fs').readFileSync('${INSTALL_DIR}/package.json','utf8')).version")"
  else
    die "Not installed."
  fi
}

usage() {
  cat <<EOF
Browser Bridge installer

Usage:
  install.sh install          Install CLI + extension (default)
  install.sh update           Pull latest and rebuild
  install.sh status           Show install location and version
  install.sh check            Verify the GitHub repo is public

Environment:
  BRIDGE_INSTALL_DIR   Install location (default: ~/.local/share/browser-bridge)
  BRIDGE_BIN_DIR       Where to link bridge (default: ~/.local/bin)
  BRIDGE_BRANCH        Git branch (default: main)
  BRIDGE_VERSION       Install a release tag instead of branch (e.g. 0.1.1)

One-liner (when repo is public):
  curl -fsSL ${RAW_BASE}/${BRANCH}/install.sh | bash
  curl -fsSL ${RAW_BASE}/${BRANCH}/install.sh | bash -s -- update
EOF
}

main() {
  local cmd="${1:-install}"
  case "$cmd" in
    install|"")  cmd_install ;;
    update)      cmd_update ;;
    status)      cmd_status ;;
    check)       check_repo_public && info "Repository is public and reachable." ;;
    -h|--help|help) usage ;;
    *) die "Unknown command: $cmd (try: install.sh --help)" ;;
  esac
}

main "${@:-install}"
