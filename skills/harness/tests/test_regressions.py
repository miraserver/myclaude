import json
import subprocess
import sys
import pytest
from test_hooks import HOOKS_DIR, STOP_HOOK, IDLE_HOOK, SESSION_HOOK, activate, run_hook, write_tasks


def test_other_worker_keeps_activation(tmp_path):
    activate(tmp_path)
    write_tasks(tmp_path, [{"id": "other", "status": "in_progress", "claimed_by": "b", "lease_expires_at": "2099-01-01T00:00:00Z"}], session_config={"concurrency_mode": "concurrent"})
    assert run_hook(STOP_HOOK, {"cwd": str(tmp_path)}, {"HARNESS_WORKER_ID": "a"}) == (0, "", "")
    assert (tmp_path / ".harness-active").exists()
    assert not (tmp_path / ".harness-reflect").exists()


def test_empty_worker_does_not_own_unclaimed(tmp_path):
    activate(tmp_path)
    write_tasks(tmp_path, [{"id": "unclaimed", "status": "in_progress"}])
    assert run_hook(IDLE_HOOK, {"cwd": str(tmp_path), "teammate_name": "alice"}, {"HARNESS_WORKER_ID": ""}) == (0, "", "")


def test_idle_bound_is_per_teammate_and_resets_on_progress(tmp_path):
    activate(tmp_path)
    tasks = [{"id": "pending", "status": "pending"}]
    write_tasks(tmp_path, tasks)
    payload = {"cwd": str(tmp_path), "teammate_name": "alice"}
    assert [run_hook(IDLE_HOOK, payload)[0] for _ in range(5)] == [2, 2, 2, 0, 0]
    assert run_hook(IDLE_HOOK, {**payload, "teammate_name": "bob"})[0] == 2
    tasks.append({"id": "done", "status": "completed", "claimed_by": "alice"})
    write_tasks(tmp_path, tasks)
    assert run_hook(IDLE_HOOK, payload)[0] == 2


@pytest.mark.parametrize("corrupt", [False, True])
def test_session_context_shape(tmp_path, corrupt):
    activate(tmp_path)
    write_tasks(tmp_path, [])
    if corrupt:
        (tmp_path / "harness-tasks.json").write_text("{")
    data = json.loads(run_hook(SESSION_HOOK, {"cwd": str(tmp_path)})[1])
    assert data["hookSpecificOutput"]["hookEventName"] == "SessionStart"
    assert isinstance(data["hookSpecificOutput"]["additionalContext"], str)


def test_emit_context_shape(tmp_path):
    code = "import sys; sys.path.insert(0, sys.argv[1]); import _harness_common as h; h.emit_context('context')"
    p = subprocess.run([sys.executable, "-c", code, str(HOOKS_DIR)], cwd=tmp_path, capture_output=True)
    assert json.loads(p.stdout)["hookSpecificOutput"] == {"hookEventName": "SessionStart", "additionalContext": "context"}


@pytest.mark.parametrize("marker", [{"session_id": "old", "count": 2}, 3, None])
def test_reflect_other_session_removed(tmp_path, marker):
    write_tasks(tmp_path, [{"id": "done", "status": "completed"}])
    path = tmp_path / ".harness-reflect"
    path.write_text(json.dumps(marker))
    assert run_hook(HOOKS_DIR / "self-reflect-stop.py", {"cwd": str(tmp_path), "session_id": "new"}) == (0, "", "")
    assert not path.exists()


def test_documented_lease_survives_separate_shells(tmp_path):
    import os
    import shutil
    from pathlib import Path
    source = (HOOKS_DIR.parent / "SKILL.md").read_text(encoding="utf-8")
    acquire = source.split("```sh\n", 1)[1].split("```", 1)[0]
    release = source.split("```sh\n", 2)[2].split("```", 1)[0]
    shell = shutil.which("bash")
    env = {**os.environ, "HARNESS_WORKER_ID": "session-a"}
    def invoke(snippet, worker="session-a"):
        return subprocess.run([shell, "-c", 'export HARNESS_STATE_ROOT="$PWD"; ' + snippet], cwd=tmp_path,
                              env={**env, "HARNESS_WORKER_ID": worker}, capture_output=True)
    assert invoke(acquire).returncode == 0
    lock = tmp_path / ".harness-cycle.lock"
    assert (lock / "owner").read_text().strip() == "session-a"
    assert invoke(acquire, "session-b").returncode == 1
    assert invoke(acquire).returncode == 0
    (lock / "timestamp").write_text("1")
    assert invoke(acquire).returncode == 1  # Expired owners cannot silently resume.
    assert lock.exists()  # Recovery must quiesce the old worker first.
    assert invoke('ROOT="$HARNESS_STATE_ROOT"; OWNER="$HARNESS_WORKER_ID"; LOCKDIR="$ROOT/.harness-cycle.lock"; ' + release, "session-b").returncode == 0
    assert lock.exists()
    assert invoke('ROOT="$HARNESS_STATE_ROOT"; OWNER="$HARNESS_WORKER_ID"; LOCKDIR="$ROOT/.harness-cycle.lock"; ' + release).returncode == 0
    assert not lock.exists()


def test_idle_heartbeat_does_not_reset_bound(tmp_path):
    activate(tmp_path)
    task = {"id": "task", "status": "in_progress", "claimed_by": "alice"}
    payload = {"cwd": str(tmp_path), "teammate_name": "alice"}
    for i in range(5):
        task["lease_expires_at"] = str(i)
        write_tasks(tmp_path, [task])
        assert run_hook(IDLE_HOOK, payload)[0] == (2 if i < 3 else 0)
    task["checkpoints"] = [{"step": 1}]
    write_tasks(tmp_path, [task])
    assert run_hook(IDLE_HOOK, payload)[0] == 2
