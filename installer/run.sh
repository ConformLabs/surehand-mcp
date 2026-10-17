#!/bin/bash
# macOS launcher: finds Node.js 18+ (or downloads a private copy into ~/.aemcp/node, verified
# against the nodejs.org checksums) and runs the AE MCP command given as arguments.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$ROOT/server/dist/ae-mcp.mjs"
PRIVATE_NODE="$HOME/.aemcp/node"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

# Files from a downloaded zip are quarantined; clear it so the other launchers open normally.
xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null

node_ok() { [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; }

NODE=""
for c in "$(command -v node 2>/dev/null)" "$PRIVATE_NODE/bin/node"; do
  if [ -n "$c" ] && node_ok "$c"; then NODE="$c"; break; fi
done

if [ -z "$NODE" ]; then
  if [ "${1:-}" = "uninstall" ]; then
    rm -rf "$HOME/Library/Application Support/Adobe/CEP/extensions/com.aemcp" "$HOME/.aemcp"
    echo "Removed the After Effects extension and ~/.aemcp (Node.js not found, so AI app settings were left unchanged)."
    exit 0
  fi
  echo "Node.js was not found. Downloading a private copy for AE MCP (one time, about 45 MB)..."
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
if [ "${1:-}" = "uninstall" ] && [ "$NODE" = "$PRIVATE_NODE/bin/node" ]; then
  rm -rf "$PRIVATE_NODE"
  rmdir "$HOME/.aemcp" 2>/dev/null
fi
exit $STATUS
