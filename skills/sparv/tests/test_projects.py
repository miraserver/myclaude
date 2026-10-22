import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/lib/projects.py"


def environment(tmp_path):
    return {**os.environ, "HOME": str(tmp_path / "home"),
            "USERPROFILE": str(tmp_path / "home")}


@pytest.mark.parametrize("mixed", [False, True])
def test_concurrent_transactions(tmp_path, mixed):
    registry = tmp_path / "home/.claude/sparv-state/projects"
    registry.parent.mkdir(parents=True)
    roots = [tmp_path / f"project-{i}" for i in range(24)]
    for root in roots:
        root.mkdir()
    initial = roots[:12] if mixed else []
    registry.write_text("".join(str(p.resolve()) + "\n" for p in initial), encoding="utf-8")
    # Widen the read/replace race so an unlocked implementation reliably fails.
    runner = (
        "import pathlib, runpy, sys, time\n"
        "read = pathlib.Path.read_text\n"
        "def slow_read(self, *args, **kwargs):\n"
        "    result = read(self, *args, **kwargs)\n"
        "    time.sleep(0.05)\n"
        "    return result\n"
        "pathlib.Path.read_text = slow_read\n"
        "runpy.run_path(sys.argv.pop(1), run_name='__main__')\n"
    )
    processes = []
    try:
        for i, root in enumerate(roots):
            action = "remove" if mixed and i < 12 else "add"
            processes.append(subprocess.Popen(
                [sys.executable, "-c", runner, str(SCRIPT), action], cwd=root,
                env=environment(tmp_path), stdout=subprocess.PIPE, stderr=subprocess.PIPE))
        for process in processes:
            stdout, stderr = process.communicate(timeout=15)
            assert process.returncode == 0, (stdout, stderr)
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait()
    expected = roots[12:] if mixed else roots
    assert set(registry.read_text(encoding="utf-8").splitlines()) == {str(p.resolve()) for p in expected}
    assert registry.with_name("projects.lock").exists()


@pytest.mark.parametrize("operation", ["open", "replace"])
@pytest.mark.parametrize("persistent", [False, True])
def test_permission_error_retry(tmp_path, operation, persistent):
    runner = (
        "import os, runpy, sys, time\n"
        f"original = os.{operation}\n"
        "attempts = 0\n"
        "def denied(*args, **kwargs):\n"
        "    global attempts\n"
        "    attempts += 1\n"
        f"    if {persistent!r} or attempts == 1:\n"
        "        raise PermissionError('busy\\nfile')\n"
        "    return original(*args, **kwargs)\n"
        f"os.{operation} = denied\n"
        "runpy.run_path(sys.argv.pop(1), run_name='__main__')\n"
    )
    started = time.monotonic()
    result = subprocess.run([sys.executable, "-c", runner, str(SCRIPT), "add"],
                            cwd=tmp_path, env=environment(tmp_path), capture_output=True, timeout=10)
    elapsed = time.monotonic() - started
    if persistent:
        assert result.returncode != 0
        assert len(result.stderr.splitlines()) == 1
        assert b"Traceback" not in result.stderr
        assert 4.5 <= elapsed < 8
    else:
        assert result.returncode == 0, result.stderr
    assert not list((tmp_path / "home/.claude/sparv-state").glob("tmp*"))


def test_lock_contention_and_lock_free_check(tmp_path):
    registry = tmp_path / "home/.claude/sparv-state/projects"
    registry.parent.mkdir(parents=True)
    registry.write_text(str(tmp_path.resolve()) + "\n", encoding="utf-8")
    with registry.with_name("projects.lock").open("a+b") as lock:
        lock.write(b"\0")
        lock.flush()
        lock.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        check = subprocess.run([sys.executable, str(SCRIPT), "check"], cwd=tmp_path,
                               env=environment(tmp_path), capture_output=True, timeout=2)
        assert check.returncode == 0, check.stderr
        started = time.monotonic()
        add = subprocess.run([sys.executable, str(SCRIPT), "add"], cwd=tmp_path,
                             env=environment(tmp_path), capture_output=True, timeout=10)
        assert add.returncode != 0
        assert 4.5 <= time.monotonic() - started < 8
        assert len(add.stderr.splitlines()) == 1 and b"Traceback" not in add.stderr
    assert registry.read_text(encoding="utf-8") == str(tmp_path.resolve()) + "\n"
