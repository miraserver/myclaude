"""Registry transactions remain reliable under contention and sharing violations."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time

import pytest

MODULE = Path(__file__).resolve().parents[1] / 'hooks/_harness_common.py'
spec = importlib.util.spec_from_file_location("registry_under_test", MODULE)
registry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(registry)


@pytest.fixture(autouse=True)
def private_home(tmp_path, monkeypatch):
    home = tmp_path / "private-home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)


def register(root):
    registry.activate_harness(root)


def test_concurrent_writers_and_readers_preserve_all_roots(tmp_path):
    register(tmp_path / "seed")
    gate = tmp_path / "start"
    stop = tmp_path / "stop"
    code = r"""
import importlib.util, sys, time
from pathlib import Path
spec = importlib.util.spec_from_file_location("registry_worker", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
base, gate, stop = map(Path, sys.argv[2:5])
role = sys.argv[5]
while not gate.exists():
    time.sleep(0.005)
if role == "reader":
    while not stop.exists():
        assert m.load_registry()["roots"], "reader lost authorization during replacement"
        time.sleep(0.001)
else:
    for i in range(60):
        root = base / (role + "-" + str(i))
        m.activate_harness(root)
        time.sleep(0.001)
"""
    processes = []
    try:
        for role in ("reader", "reader", "0", "1", "2", "3"):
            processes.append(subprocess.Popen(
                [sys.executable, "-c", code, str(MODULE), str(tmp_path),
                 str(gate), str(stop), role], stdout=subprocess.PIPE, stderr=subprocess.PIPE))
        gate.touch()
        for process in processes[2:]:
            stdout, stderr = process.communicate(timeout=40)
            assert (process.returncode, stdout, stderr) == (0, b"", b""), stderr.decode("utf-8", errors="replace")
        stop.touch()
        for process in processes[:2]:
            stdout, stderr = process.communicate(timeout=10)
            assert (process.returncode, stdout, stderr) == (0, b"", b""), stderr.decode("utf-8", errors="replace")
    finally:
        stop.touch()
        for process in processes:
            if process.poll() is None:
                process.kill()
            process.communicate()
    expected = {str((tmp_path / "seed").resolve())} | {
        str((tmp_path / f"{worker}-{i}").resolve())
        for worker in range(4) for i in range(60)}
    assert set(registry.load_registry()["roots"]) == expected
    assert not registry.registry_path().with_name("registry.lock").exists()
    assert not list(registry.registry_path().parent.glob("registry-*.tmp"))
    if os.name == "posix":
        assert stat.S_IMODE(registry.registry_path().stat().st_mode) == 0o600


def test_stale_lock_is_broken(tmp_path):
    register(tmp_path / "seed")
    lock = registry.registry_path().with_name("registry.lock")
    lock.touch()
    old = time.time() - 31
    os.utime(lock, (old, old))
    register(tmp_path / "added")
    assert str((tmp_path / "added").resolve()) in set(registry.load_registry()["roots"])
    assert not lock.exists()


def test_live_holder_times_out_without_changing_registry(tmp_path):
    register(tmp_path / "seed")
    before = registry.registry_path().read_bytes()
    lock = registry.registry_path().with_name("registry.lock")
    holder = subprocess.Popen([sys.executable, "-u", "-c",
        "import os,sys;fd=os.open(sys.argv[1],os.O_CREAT|os.O_EXCL|os.O_WRONLY);"
        "os.close(fd);print('ready',flush=True);sys.stdin.read()", str(lock)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        assert holder.stdout.readline().strip() == b"ready"
        started = time.monotonic()
        with pytest.raises(TimeoutError, match="Timed out waiting for registry lock"):
            register(tmp_path / "blocked")
        assert 4.9 <= time.monotonic() - started < 8
        assert holder.poll() is None
        assert registry.registry_path().read_bytes() == before
        assert lock.exists()
    finally:
        holder.communicate(input=b"", timeout=5)
        lock.unlink(missing_ok=True)


@pytest.mark.parametrize("operation", ["read", "replace"])
@pytest.mark.parametrize("persistent", [False, True])
def test_permission_errors_are_retried(tmp_path, monkeypatch, operation, persistent):
    register(tmp_path / "seed")
    before = registry.registry_path().read_bytes()
    calls = []
    clock = [0.0]
    monkeypatch.setattr(registry.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(registry.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    original = Path.read_text if operation == "read" else registry.os.replace

    def denied(*args, **kwargs):
        calls.append(clock[0])
        if persistent or len(calls) < 3:
            raise PermissionError("sharing violation")
        return original(*args, **kwargs)

    if operation == "read":
        monkeypatch.setattr(Path, "read_text", denied)
        result = registry.load_registry()
        assert bool(result and result["roots"]) == (not persistent)
        assert clock[0] < 1.03
        if persistent:
            assert clock[0] >= 1.0
    else:
        monkeypatch.setattr(registry.os, "replace", denied)
        if persistent:
            with pytest.raises(PermissionError, match="sharing violation"):
                register(tmp_path / "added")
            assert registry.registry_path().read_bytes() == before
            assert 2.0 <= clock[0] < 2.03
        else:
            register(tmp_path / "added")
            assert str((tmp_path / "added").resolve()) in set(registry.load_registry()["roots"])
        assert not registry.registry_path().with_name("registry.lock").exists()
        assert not list(registry.registry_path().parent.glob("registry-*.tmp"))
    assert len(calls) >= 3


def test_malformed_json_fails_closed_without_retry(tmp_path, monkeypatch):
    path = registry.registry_path()
    path.parent.mkdir(parents=True)
    path.write_text("{", encoding="utf-8")
    def unexpected_sleep(seconds):
        pytest.fail("malformed JSON must not retry")
    monkeypatch.setattr(registry.time, "sleep", unexpected_sleep)
    assert not registry.load_registry()["roots"]


def test_lock_creation_sharing_violation_is_retried(tmp_path, monkeypatch):
    register(tmp_path / "seed")
    original = registry.os.open
    attempts = []

    def open_lock(path, *args, **kwargs):
        if Path(path).name == "registry.lock":
            attempts.append(path)
            if len(attempts) == 1:
                raise PermissionError("lock deletion in progress")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(registry.os, "open", open_lock)
    register(tmp_path / "added")
    assert len(attempts) == 2
    assert str((tmp_path / "added").resolve()) in set(registry.load_registry()["roots"])
