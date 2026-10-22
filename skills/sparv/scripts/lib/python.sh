# Select a usable Python interpreter, including the Windows launcher.
sparv_python() {
    if command -v python3 >/dev/null 2>&1 && python3 -c 'pass' >/dev/null 2>&1; then
        python3 "$@"
    elif command -v python >/dev/null 2>&1 && python -c 'pass' >/dev/null 2>&1; then
        python "$@"
    elif command -v py >/dev/null 2>&1 && py -3 -c 'pass' >/dev/null 2>&1; then
        py -3 "$@"
    else
        echo "SPARV: Python interpreter required (python3, python, or py -3)." >&2
        return 1
    fi
}
