"""Registry transactions remain reliable under contention and sharing violations."""
import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys
import time
from types import SimpleNamespace

import pytest

MODULE = Path(__file__).resolve().parents[1] / 'scripts/task.py'
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
    registry.register_task(str(root), str(root / ".claude/do-tasks/task/task.md"), "echo test", "now")


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
        assert m.load_registry(), "reader lost authorization during replacement"
        time.sleep(0.001)
else:
    for i in range(60):
        root = base / (role + "-" + str(i))
        m.register_task(str(root), str(root / ".claude/do-tasks/task/task.md"), "echo test", "now")
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
    assert set(registry.load_registry()) == expected
    assert registry.registry_path().with_name("registry.lock").exists()
    assert not list(registry.registry_path().parent.glob("registry-*.tmp"))
    if os.name == "posix":
        assert stat.S_IMODE(registry.registry_path().stat().st_mode) == 0o600


@pytest.mark.parametrize("content", [b"", b"dead:token", b"\x00\xffarbitrary old content\n"])
def test_leftover_lock_does_not_block(tmp_path, content):
    lock = registry.registry_path().with_name("registry.lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_bytes(content)
    started = time.monotonic()
    register(tmp_path / "added")
    assert time.monotonic() - started < 2
    assert str((tmp_path / "added").resolve()) in set(registry.load_registry())
    assert lock.read_bytes() == content


@pytest.fixture
def lock_holder(tmp_path):
    register(tmp_path / "seed")
    code = """
import importlib.util, sys
spec = importlib.util.spec_from_file_location("lock_holder", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with m._registry_lock():
    print("ready", flush=True)
    sys.stdin.read()
"""
    process = subprocess.Popen([sys.executable, "-c", code, str(MODULE)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        assert process.stdout.readline().strip() == b"ready"
        yield process
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=5)


def test_live_holder_times_out_without_changing_registry(tmp_path, monkeypatch, lock_holder):
    path = registry.registry_path()
    before = path.read_bytes()
    # Speed up only the lock's deadline clock, keeping subprocess clocks real.
    monkeypatch.setattr(registry, "time", SimpleNamespace(
        monotonic=lambda: time.monotonic() * 25, sleep=time.sleep))
    started = time.monotonic()
    with pytest.raises(TimeoutError, match="Timed out waiting for registry lock"):
        register(tmp_path / "blocked")
    assert 0.19 <= time.monotonic() - started < 2
    assert lock_holder.poll() is None
    assert path.read_bytes() == before
    assert path.with_name("registry.lock").exists()


@pytest.mark.parametrize("method", ["kill", "terminate"])
def test_process_death_releases_lock(tmp_path, lock_holder, method):
    getattr(lock_holder, method)()
    lock_holder.communicate(timeout=5)
    started = time.monotonic()
    register(tmp_path / "recovered")
    assert time.monotonic() - started < 2
    assert str((tmp_path / "recovered").resolve()) in set(registry.load_registry())
    assert registry.registry_path().with_name("registry.lock").exists()


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
        assert bool(result and result) == (not persistent)
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
            assert str((tmp_path / "added").resolve()) in set(registry.load_registry())
        assert registry.registry_path().with_name("registry.lock").exists()
        assert not list(registry.registry_path().parent.glob("registry-*.tmp"))
    assert len(calls) >= 3


def test_malformed_json_fails_closed_without_retry(tmp_path, monkeypatch):
    path = registry.registry_path()
    path.parent.mkdir(parents=True)
    path.write_text("{", encoding="utf-8")
    def unexpected_sleep(seconds):
        pytest.fail("malformed JSON must not retry")
    monkeypatch.setattr(registry.time, "sleep", unexpected_sleep)
    assert not registry.load_registry()


@pytest.mark.parametrize("failure", ["permission", "oserror", "malformed", "schema"])
def test_writer_never_overwrites_unreadable_registry(tmp_path, monkeypatch, failure):
    register(tmp_path / "seed")
    path = registry.registry_path()
    if failure in ("malformed", "schema"):
        path.write_text("{" if failure == "malformed" else "[]", encoding="utf-8")
    before = path.read_bytes()
    if failure in ("permission", "oserror"):
        original = Path.read_text
        def denied(self, *args, **kwargs):
            if self == path:
                raise PermissionError("persistent") if failure == "permission" else OSError("read failed")
            return original(self, *args, **kwargs)
        monkeypatch.setattr(Path, "read_text", denied)
        clock = [0.0]
        monkeypatch.setattr(registry.time, "monotonic", lambda: clock[0])
        monkeypatch.setattr(registry.time, "sleep", lambda n: clock.__setitem__(0, clock[0] + n))
    with pytest.raises((OSError, ValueError)):
        register(tmp_path / "new")
    assert path.read_bytes() == before


@pytest.mark.parametrize("persistent", [False, True])
def test_lock_open_permission_error_retries_with_shared_deadline(tmp_path, monkeypatch, persistent):
    clock = [0.0]
    calls = []
    original = registry.os.open
    monkeypatch.setattr(registry, "time", SimpleNamespace(
        monotonic=lambda: clock[0],
        sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds)))

    def denied(*args, **kwargs):
        calls.append(clock[0])
        if persistent or len(calls) == 1:
            raise PermissionError("sharing violation")
        return original(*args, **kwargs)

    monkeypatch.setattr(registry.os, "open", denied)
    if persistent:
        with pytest.raises(TimeoutError, match="Timed out waiting for registry lock"):
            with registry._registry_lock():
                pytest.fail("must not acquire the lock")
        assert 5.0 <= clock[0] < 5.03
    else:
        with registry._registry_lock():
            assert len(calls) == 2
        assert clock[0] == 0.02
    assert len(calls) > 1
