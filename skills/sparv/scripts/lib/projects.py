"""User-local SPARV project authorization, independent of repository state."""
import os
from pathlib import Path
import sys
import tempfile


def main():
    path = Path.home() / ".claude" / "sparv-state" / "projects"
    root = str(Path.cwd().resolve())
    action = sys.argv[1]
    try:
        projects = set(path.read_text(encoding="utf-8").splitlines())
    except FileNotFoundError:
        projects = set()
    except (OSError, UnicodeError):
        if action == "check":
            return 1
        raise
    if action == "check":
        return 0 if root in projects else 1
    if action == "add":
        projects.add(root)
    else:
        projects.discard(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         delete=False) as output:
            temporary = output.name
            output.write("".join(entry + "\n" for entry in sorted(projects)))
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    return 0


if __name__ == "__main__":
    sys.exit(main())
