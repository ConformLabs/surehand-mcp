#!/bin/bash
# Double-click to connect ChatGPT (starts a local server and a secure tunnel; keep the window open).
bash "$(dirname "$0")/../run.sh" chatgpt "$@"
echo
read -r -p "Press Enter to close..." || true
