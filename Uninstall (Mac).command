#!/bin/bash
# Double-click to remove AE MCP.
bash "$(dirname "$0")/installer/run.sh" uninstall "$@"
echo
read -r -p "Press Enter to close..."
