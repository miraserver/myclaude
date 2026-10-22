"""CLI and hook regressions using disposable projects and homes."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/task.py"
spec = importlib.util.spec_from_file_location("batch9_task", SCRIPT)
task = importlib.util.module_from_spec(spec)
spec.loader.exec_module(task)


@pytest.fixture
def project(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("CLAUDE_PROJECT_DIR", str(tmp_path))
    monkeypatch.chdir(tmp_path)
    return tmp_path


def cli(*args):
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True)


def test_bom_stop_blocks_exactly_like_plain_payload(project):
    task.create_task("unfinished")
    payload = json.dumps({"cwd": str(project), "session_id": "test"}).encode("utf-8")
    results = []
    for prefix in (b"", b"\xef\xbb\xbf"):
        result = subprocess.run([sys.executable, str(ROOT / "hooks/stop-hook.py")],
                                input=prefix + payload, capture_output=True)
        assert result.returncode == 0
        assert result.stderr == b""
        results.append(json.loads(result.stdout))
    assert results[0]["decision"] == "block"
    assert results[1] == results[0]


@pytest.mark.parametrize("command", ["create", "set-verify"])
def test_corrupt_registry_cli_warns_and_succeeds(project, command):
    task.create_task("initial")
    path = task.registry_path()
    path.write_text("{", encoding="utf-8")
    result = cli(command, "changed")
    assert result.returncode == 0, result.stderr
    assert path.read_bytes() == b"{"
    assert len(result.stderr.splitlines()) == 1
    assert result.stderr.startswith(b"Warning:")
    assert b"Traceback" not in result.stderr
    loaded = task.load_task(str(project))
    assert loaded[1]["title" if command == "create" else "verify_command"] == "changed"


@pytest.mark.parametrize("existing", [False, True])
def test_worktree_export_round_trips_through_bash(project, monkeypatch, capsys, existing):
    bash = shutil.which("bash")
    assert bash, "bash is required to verify the printed export"
    task.create_task("export")
    directory = project / "worktree with spaces and ' quote"
    if existing:
        directory.mkdir()
        path, frontmatter, body = task.load_task(str(project))
        frontmatter["worktree_dir"] = directory.as_posix()
        task.save_task(path, frontmatter, body)
    else:
        monkeypatch.setattr(task, "create_worktree", lambda *args: directory.as_posix())
    assert task.attach_worktree()
    line = capsys.readouterr().out
    result = subprocess.run([bash, "--noprofile", "--norc", "-c",
                             line + 'printf "%s" "$DO_WORKTREE_DIR"'],
                            capture_output=True, env={**os.environ, "BASH_ENV": ""})
    assert result.returncode == 0, result.stderr
    assert result.stdout.decode("utf-8") == directory.as_posix()
