"""Repository state must never authorize globally installed hooks."""
import json
import os
import stat
import subprocess
import sys

import pytest

from test_hooks import HOOKS_DIR, STOP_HOOK, activate, run_hook, write_tasks
from _harness_common import load_registry, registered_root, registry_path


HOOKS = sorted(HOOKS_DIR.glob("*-*.py"))
ACTIVATION = HOOKS_DIR.parent / "scripts" / "activation.py"


@pytest.mark.parametrize("script", HOOKS, ids=lambda p: p.stem)
@pytest.mark.parametrize("source", ["cwd", "parent", "project", "project-parent", "override"])
def test_unregistered_markers_are_silent(tmp_path, script, source):
    root = tmp_path / "untrusted"
    root.mkdir()
    write_tasks(root, [{"id": "evil", "title": "Injected task", "status": "pending"}])
    (root / ".harness-active").touch()
    (root / ".harness-reflect").write_text(json.dumps({"session_id": "victim", "count": 0}))
    child = root / "nested"
    child.mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    payload = {"cwd": str(root), "session_id": "victim", "teammate_name": "worker"}
    env = {}
    if source == "parent":
        payload["cwd"] = str(child)
    elif source.startswith("project"):
        payload["cwd"] = str(elsewhere)
        env["CLAUDE_PROJECT_DIR"] = str(child if source == "project-parent" else root)
    elif source == "override":
        payload["cwd"] = str(elsewhere)
        env["HARNESS_STATE_ROOT"] = str(root)
    before = {p.name: p.read_bytes() for p in root.iterdir() if p.is_file()}
    assert run_hook(script, payload, env) == (0, "", "")
    assert {p.name: p.read_bytes() for p in root.iterdir() if p.is_file()} == before
    assert not registry_path().exists()


@pytest.mark.parametrize("contents", ["{", "[]", '{}', '{"roots": "bad"}', '{"roots": [1]}'])
def test_malformed_registry_fails_closed(tmp_path, contents):
    write_tasks(tmp_path, [{"id": "evil", "status": "pending"}])
    (tmp_path / ".harness-active").touch()
    path = registry_path()
    path.parent.mkdir(parents=True)
    path.write_text(contents, encoding="utf-8")
    assert run_hook(STOP_HOOK, {"cwd": str(tmp_path)}) == (0, "", "")


@pytest.mark.parametrize("source", ["cwd", "parent", "project", "override"])
def test_registered_root_blocks_as_before(tmp_path, source):
    root = tmp_path / "trusted"
    root.mkdir()
    write_tasks(root, [{"id": "task", "title": "Authorized task", "status": "pending"}])
    activate(root)
    child = root / "nested"
    child.mkdir()
    payload = {"cwd": str(child if source == "parent" else root)}
    env = {}
    if source in ("project", "override"):
        payload["cwd"] = str(tmp_path)
        env["CLAUDE_PROJECT_DIR" if source == "project" else "HARNESS_STATE_ROOT"] = str(root)
    code, stdout, stderr = run_hook(STOP_HOOK, payload, env)
    assert (code, stderr) == (0, "")
    assert json.loads(stdout)["decision"] == "block"
    assert "Authorized task" in json.loads(stdout)["reason"]


def invoke_activation(command, root):
    proc = subprocess.run([sys.executable, str(ACTIVATION), command, str(root)],
                          cwd=root, capture_output=True, timeout=10)
    assert (proc.returncode, proc.stdout, proc.stderr) == (0, b"", b"")


def test_activation_and_deactivation_register_automatically(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    write_tasks(root, [{"id": "task", "status": "pending"}])
    invoke_activation("activate", root / ".")
    invoke_activation("activate", root)  # Idempotent, resolved paths only.
    assert load_registry()["roots"] == [str(root.resolve())]
    assert (root / ".harness-active").is_file()
    assert registered_root(root)
    if os.name == "posix":
        assert stat.S_IMODE(registry_path().stat().st_mode) == 0o600
    assert list(registry_path().parent.glob("registry-*.tmp")) == []
    invoke_activation("deactivate", root)
    assert not registered_root(root)
    assert not (root / ".harness-active").exists()
    # Reintroducing repository markers must not reactivate hooks.
    (root / ".harness-active").touch()
    assert run_hook(STOP_HOOK, {"cwd": str(root)}) == (0, "", "")


def test_completion_unregisters_and_reflects_only_in_finishing_session(tmp_path):
    write_tasks(tmp_path, [{"id": "done", "status": "completed"}])
    activate(tmp_path)
    assert run_hook(STOP_HOOK, {"cwd": str(tmp_path), "session_id": "owner"}) == (0, "", "")
    assert not registered_root(tmp_path)
    assert not (tmp_path / ".harness-active").exists()
    reflect = HOOKS_DIR / "self-reflect-stop.py"
    assert run_hook(reflect, {"cwd": str(tmp_path), "session_id": "other"}) == (0, "", "")
    assert json.loads(run_hook(reflect, {"cwd": str(tmp_path), "session_id": "owner"})[1])["decision"] == "block"
    invoke_activation("deactivate", tmp_path)
    assert run_hook(reflect, {"cwd": str(tmp_path), "session_id": "owner"}) == (0, "", "")
