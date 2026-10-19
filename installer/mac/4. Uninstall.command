#!/bin/bash
# Double-click to remove Surehand MCP.
bash "$(dirname "$0")/../run.sh" uninstall "$@"
echo
read -r -p "Press Enter to close..." || true
