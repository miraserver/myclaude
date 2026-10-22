"""User-local SPARV project authorization, independent of repository state."""
import os
import errno
from pathlib import Path
import sys
import tempfile
import time
from contextlib import contextmanager


def pause(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("project authorization timed out")
    time.sleep(min(0.05, remaining))


def retry_permission(operation, deadline):
    while True:
        try:
            return operation()
        except PermissionError:
            pause(deadline)


@contextmanager
def project_lock(path, deadline):
    descriptor = retry_permission(
        lambda: os.open(path, os.O_CREAT | os.O_RDWR, 0o600), deadline)
    try:
        while True:
            try:
                if os.name == "nt":
                    import msvcrt
                    os.lseek(descriptor, 0, os.SEEK_SET)
                    msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as error:
                if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                pause(deadline)
        yield
    finally:
        # Closing releases the OS lock; keep the lock file for future callers.
        os.close(descriptor)


def read_projects(path):
    try:
        return set(path.read_text(encoding="utf-8").splitlines())
    except FileNotFoundError:
        return set()


def main():
    path = Path.home() / ".claude" / "sparv-state" / "projects"
    root = str(Path.cwd().resolve())
    action = sys.argv[1]
    if action == "check":
        try:
            return 0 if root in read_projects(path) else 1
        except (OSError, UnicodeError):
            return 1
    deadline = time.monotonic() + 5
    path.parent.mkdir(parents=True, exist_ok=True)
    with project_lock(path.with_name("projects.lock"), deadline):
        projects = read_projects(path)
        if action == "add":
            projects.add(root)
        else:
            projects.discard(root)
        temporary = None
        try:
            with retry_permission(
                lambda: tempfile.NamedTemporaryFile(mode="w", encoding="utf-8",
                                                    dir=path.parent, delete=False), deadline) as output:
                temporary = output.name
                output.write("".join(entry + "\n" for entry in sorted(projects)))
            retry_permission(lambda: os.replace(temporary, path), deadline)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, UnicodeError) as error:
        message = "SPARV project authorization: " + " ".join(str(error).splitlines())
        print(message.encode("ascii", errors="backslashreplace").decode("ascii"), file=sys.stderr)
        sys.exit(1)
