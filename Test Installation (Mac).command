#!/bin/bash
# Double-click to check that AE MCP is installed and can talk to After Effects.
bash "$(dirname "$0")/installer/run.sh" selftest "$@"
echo
read -r -p "Press Enter to close..."
