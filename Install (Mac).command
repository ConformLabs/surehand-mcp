#!/bin/bash
# Double-click to install AE MCP and connect your AI apps.
bash "$(dirname "$0")/installer/run.sh" install "$@"
echo
read -r -p "Press Enter to close..."
