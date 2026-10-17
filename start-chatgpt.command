#!/bin/bash
# Double-click to connect AE MCP to ChatGPT (HTTP server + tunnel).
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.volta/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required but was not found."
  echo "Install the LTS version from https://nodejs.org (or: brew install node), then run this again."
  open "https://nodejs.org/en/download" 2>/dev/null
  exit 1
fi
node installer/chatgpt.mjs "$@"
