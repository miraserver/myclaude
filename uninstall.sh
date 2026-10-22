#!/bin/bash
set -e
if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: Node.js is required to uninstall myclaude. Install Node.js and retry." >&2
    exit 1
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/bin/cli.js" uninstall "$@"
