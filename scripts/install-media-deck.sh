#!/bin/bash
set -eu

# Resolve script directory to allow running from anywhere
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_SCRIPT="$SCRIPT_DIR/install-media-deck.py"

# Make sure Python 3 is installed
if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: Python 3 is required but was not found on your system." >&2
  exit 1
fi

# Forward all arguments to the python script
exec python3 "$PYTHON_SCRIPT" "$@"
