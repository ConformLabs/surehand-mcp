#!/bin/bash
# macOS launcher: finds Node.js 18+ (or downloads a private copy into ~/.surehand/node, verified
# against the nodejs.org checksums) and runs the Surehand MCP command given as arguments.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# release layout: the server sits next to this script; source checkout: server/dist
SERVER="$HERE/surehand-ae.mjs"
[ -f "$SERVER" ] || SERVER="$ROOT/server/dist/surehand-ae.mjs"
SUREHAND="$HOME/.surehand"
PRIVATE_NODE="$SUREHAND/node"
# version 1.3 kept it in ~/.aemcp/node (the server moves it on its first run)
LEGACY_NODE="$HOME/.aemcp/node"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

# Files from a downloaded zip are quarantined; clear it so the other launchers open normally.
# (a downloaded release folder; not a development checkout, where it would walk every worktree and node_modules)
[ -d "$ROOT/.git" ] || xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null

# Surehand MCP's own entries in ~/.surehand/ae and ~/.aemcp: the same list as OWN_FILES in
# server/src/cli/uninstall.ts (a test keeps them equal). Everything else there is the user's.
OWN_FILES="server config.json runtime.json extension-hash bridge-status.json instances update-check.json activity.jsonl tmp renders compat install.log chatgpt.json chatgpt.lock MOVED.txt"

# Another Surehand app (~/.surehand/<app>) is installed: the shared Node.js stays for it.
other_apps() {
  local d n
  for d in "$SUREHAND"/*/; do
    [ -d "$d" ] || continue
    n="$(basename "$d")"
    case "$n" in ae|node|ffmpeg) ;; *) return 0 ;; esac
  done
  return 1
}

# Removes only our own entries of a folder (never the user's data) and says what was kept.
remove_own() {
  local dir="$1" kept="" p name
  [ -d "$dir" ] || return 0
  for p in "$dir"/* "$dir"/.[!.]*; do
    [ -e "$p" ] || [ -L "$p" ] || continue
    name="$(basename "$p")"
    if [ "$name" = "node" ]; then
      # ~/.aemcp/node: 1.3's private Node.js, or the link the move left; the shared one is handled below
      [ "$dir" = "$HOME/.aemcp" ] && rm -rf "$p"
      continue
    fi
    case " $OWN_FILES " in
      *" $name "*) rm -rf "$p" ;;
      *) kept="$kept $name" ;;
    esac
  done
  rmdir "$dir" 2>/dev/null
  [ -n "$kept" ] && echo "Kept your files in $dir:$kept"
  return 0
}

node_ok() { [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; }

NODE=""
CANDIDATES=("$(command -v node 2>/dev/null)" "$PRIVATE_NODE/bin/node" "$LEGACY_NODE/bin/node")
# CI/testing: SUREHAND_AE_FORCE_NODE_DOWNLOAD=1 (or AEMCP_FORCE_NODE_DOWNLOAD=1) ignores the system Node, so the private download is used
[ -n "${SUREHAND_AE_FORCE_NODE_DOWNLOAD:-}${AEMCP_FORCE_NODE_DOWNLOAD:-}" ] && CANDIDATES=("$PRIVATE_NODE/bin/node")
for c in "${CANDIDATES[@]+"${CANDIDATES[@]}"}"; do
  if [ -n "$c" ] && node_ok "$c"; then NODE="$c"; break; fi
done

if [ -z "$NODE" ]; then
  if [ "${1:-}" = "uninstall" ]; then
    # without Node.js the server can't run its uninstaller: remove the extension and Surehand MCP's
    # own files only; checkpoints, backups, history, proofs and anything else stay
    rm -rf "$HOME/Library/Application Support/Adobe/CEP/extensions/com.aemcp"
    remove_own "$SUREHAND/ae"
    remove_own "$HOME/.aemcp"
    rm -f "$SUREHAND/migration.log"
    if other_apps; then echo "Kept $PRIVATE_NODE (another Surehand app uses it)."; else rm -rf "$PRIVATE_NODE"; fi
    rmdir "$SUREHAND" 2>/dev/null
    echo "Removed the After Effects extension and Surehand MCP's own files (Node.js not found, so AI app settings were left unchanged)."
    exit 0
  fi
  echo "Node.js was not found. Downloading a private copy for Surehand MCP (one time, about 45 MB)..."
  case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
  BASE="https://nodejs.org/dist/latest-v22.x"
  LINE="$(curl -fsSL "$BASE/SHASUMS256.txt" | grep " node-v[0-9.]*-darwin-$ARCH.tar.gz$")"
  FILE="$(echo "$LINE" | awk '{print $2}')"
  SUM="$(echo "$LINE" | awk '{print $1}')"
  TMP="$(mktemp -d)"
  if [ -z "$FILE" ] || ! curl -fL --progress-bar "$BASE/$FILE" -o "$TMP/$FILE"; then
    echo "Download failed. Check your internet connection, or install Node.js from https://nodejs.org and run this again."
    open "https://nodejs.org/en/download" 2>/dev/null
    exit 1
  fi
  if [ "$(shasum -a 256 "$TMP/$FILE" | awk '{print $1}')" != "$SUM" ]; then
    echo "The downloaded Node.js failed its checksum check; aborting."
    rm -rf "$TMP"
    exit 1
  fi
  rm -rf "$PRIVATE_NODE" && mkdir -p "$PRIVATE_NODE"
  tar -xzf "$TMP/$FILE" -C "$PRIVATE_NODE" --strip-components 1
  rm -rf "$TMP"
  NODE="$PRIVATE_NODE/bin/node"
  echo "Node.js $("$NODE" --version) installed to $PRIVATE_NODE"
fi

"$NODE" "$SERVER" "$@"
STATUS=$?
# The private Node can only be deleted after it has finished running the uninstaller.
if [ "${1:-}" = "uninstall" ]; then
  case "$NODE" in
    "$PRIVATE_NODE/bin/node" | "$LEGACY_NODE/bin/node")
      # ~/.aemcp/node: 1.3's own Node.js or a link; the shared one only when no other Surehand app needs it
      rm -rf "$LEGACY_NODE"
      other_apps || rm -rf "$PRIVATE_NODE" ;;
  esac
  rmdir "$SUREHAND" "$HOME/.aemcp" 2>/dev/null
fi
exit $STATUS
