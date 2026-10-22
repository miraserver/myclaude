#!/bin/bash
# Only explicitly authorized active sessions may enforce or modify state.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/state-lock.sh"
sparv_python "$SCRIPT_DIR/lib/projects.py" check || exit 0
unset SPARV_DIR STATE_FILE JOURNAL_FILE
sparv_auto_detect || exit 0
case "${1:-}" in
Stop)
    active="$(sparv_python -c 'import json,sys; print(json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace") or "{}").get("stop_hook_active") is True)' 2>/dev/null)" || exit 0
    [ "$active" = True ] && exit 0
    iteration="$(sparv_yaml_get_int iteration_count 0)"
    maximum="$(sparv_yaml_get_int max_iterations 0)"
    failures="$(sparv_yaml_get_int consecutive_failures 0)"
    if { [ "$maximum" -gt 0 ] && [ "$iteration" -ge "$maximum" ]; } || [ "$failures" -ge 3 ]; then
        echo "SPARV: escalation required (iteration=$iteration/$maximum, consecutive_failures=$failures); pause and hand over to the user." >&2
        exit 0
    fi
    bash "$SCRIPT_DIR/reboot-test.sh" --strict || exit 2
    ;;
PostToolUse) bash "$SCRIPT_DIR/save-progress.sh" --hook || true ;;
PreToolUse) bash "$SCRIPT_DIR/check-ehrb.sh" --diff --dry-run || true ;;
esac
