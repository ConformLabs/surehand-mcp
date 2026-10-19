#!/bin/bash
# Double-click to check that Surehand MCP is installed and can talk to After Effects.
bash "$(dirname "$0")/../run.sh" selftest "$@"
echo
read -r -p "Press Enter to close..." || true
