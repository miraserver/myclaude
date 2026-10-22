import json
import os
from pathlib import Path
import shutil
import subprocess
import pytest

SKILL = Path(__file__).resolve().parents[1]
BASH = shutil.which("bash")


def bash(tmp_path, script, *args, payload=None):
    # Copy scripts so Windows paths and line ending conversions cannot affect Bash.
    target = tmp_path / "skill"
    if not target.exists():
        shutil.copytree(SKILL / "scripts", target / "scripts")
        for p in target.rglob("*.sh"):
            p.write_bytes(p.read_bytes().replace(b"\r\n", b"\n"))
    env = {**os.environ, "HOME": str(tmp_path / "home"), "USERPROFILE": str(tmp_path / "home")}
    return subprocess.run([BASH, "skill/scripts/" + script, *args], cwd=tmp_path, env=env, input=json.dumps(payload or {}).encode(), capture_output=True)


def sessions(tmp_path):
    plan = tmp_path / ".sparv/plan"
    for name in ["20000101000000", "20200101000000", "20250101000000"]:
        (plan / name).mkdir(parents=True)
    newest = plan / "20250101000000"
    for name in ["20200101000000", newest.name]:
        (plan / name / "state.yaml").write_text('session_id: "test"\ncurrent_phase: "act"\naction_count: 0\nconsecutive_failures: 0\n')
    (newest / "journal.md").write_text("journal\n")
    return newest


def test_init_finds_newest_complete_session(tmp_path):
    newest = sessions(tmp_path)
    p = bash(tmp_path, "init-session.sh")
    assert p.returncode == 0, p.stderr
    assert newest.name.encode() in p.stdout
    assert len(list((tmp_path / ".sparv/plan").iterdir())) == 3


def test_init_existing_session_only_registers_project(tmp_path):
    sessions(tmp_path)
    before = {p.relative_to(tmp_path): p.read_bytes()
              for p in (tmp_path / ".sparv").rglob("*") if p.is_file()}
    result = bash(tmp_path, "init-session.sh", "ignored-feature")
    assert result.returncode == 0, result.stderr
    after = {p.relative_to(tmp_path): p.read_bytes()
             for p in (tmp_path / ".sparv").rglob("*") if p.is_file()}
    assert before == after
    registry = tmp_path / "home/.claude/sparv-state/projects"
    assert registry.read_text(encoding="utf-8").splitlines() == [str(tmp_path.resolve())]


def test_archive_finds_newest_complete_session(tmp_path):
    newest = sessions(tmp_path)
    p = bash(tmp_path, "archive-session.sh")
    assert p.returncode == 0, p.stderr
    assert (tmp_path / ".sparv/history" / newest.name / "state.yaml").exists()
    assert (tmp_path / ".sparv/plan/20000101000000").exists()
    assert (tmp_path / ".sparv/plan/20200101000000/state.yaml").exists()


def test_progress_hook_reads_stdin_tool_name(tmp_path):
    newest = sessions(tmp_path)
    for _ in range(2):
        p = bash(tmp_path, "save-progress.sh", "--hook", payload={"tool_name": "Write"})
        assert p.returncode == 0, p.stderr
    assert "Tool: Write" in (newest / "journal.md").read_text()


def test_hook_paths_and_blocking_policy():
    hooks = json.loads((SKILL / "hooks/hooks.json").read_text())["hooks"]
    for event, entries in hooks.items():
        command = entries[0]["hooks"][0]["command"]
        assert '${CLAUDE_PLUGIN_ROOT}/scripts/' in command
        assert '${SKILL_PATH}' not in command and '${TOOL_NAME' not in command
        assert ('|| true' in command) == (event != 'Stop')
    assert 'exit 2' in hooks['Stop'][0]['hooks'][0]['command']


@pytest.mark.parametrize("event", ["Stop", "PostToolUse", "PreToolUse"])
def test_unauthorized_state_is_inert(tmp_path, event):
    newest = sessions(tmp_path)
    before = {p: p.read_bytes() for p in newest.iterdir()}
    result = bash(tmp_path, "session-hook.sh", event)
    assert result.returncode == 0, result.stderr
    assert result.stdout == result.stderr == b""
    assert before == {p: p.read_bytes() for p in newest.iterdir()}


def test_archived_stop_allows_exit(tmp_path):
    assert bash(tmp_path, "init-session.sh", "feature").returncode == 0
    assert (tmp_path / "home/.claude/sparv-state/projects").read_text().strip()
    assert bash(tmp_path, "archive-session.sh").returncode == 0
    assert not (tmp_path / "home/.claude/sparv-state/projects").read_text().strip()
    result = bash(tmp_path, "session-hook.sh", "Stop")
    assert result.returncode == 0 and result.stdout == result.stderr == b""


@pytest.mark.parametrize("mode", ["strict", "iterations", "failures", "recursive"])
def test_authorized_stop_policy(tmp_path, mode):
    assert bash(tmp_path, "init-session.sh", "feature").returncode == 0
    state = next((tmp_path / ".sparv/plan").glob("*/state.yaml"))
    text = state.read_text()
    if mode == "iterations":
        text = text.replace("iteration_count: 0", "iteration_count: 12")
    if mode == "failures":
        text = text.replace("consecutive_failures: 0", "consecutive_failures: 3")
    state.write_text(text)
    result = bash(tmp_path, "session-hook.sh", "Stop", payload={"stop_hook_active": mode == "recursive"})
    assert result.returncode == (2 if mode == "strict" else 0), result.stderr
    if mode in ("iterations", "failures"):
        assert b"escalation" in result.stderr
    if mode == "recursive":
        assert result.stdout == result.stderr == b""


def test_python_helper_falls_back_to_python(tmp_path):
    # Use wrappers to make python3 unavailable without changing the real PATH.
    result = bash(tmp_path, "init-session.sh", "feature")
    assert result.returncode == 0, result.stderr
    script = tmp_path / "fallback.sh"
    import sys
    executable = sys.executable.replace(chr(92), "/")
    script.write_text(
        'source skill/scripts/lib/python.sh\n'
        'command() { if [ "$1" = -v ] && [ "$2" = python3 ]; then return 1; fi; builtin command "$@"; }\n'
        f'python() {{ "{executable}" "$@"; }}\n'
        'sparv_python -c "print(42)"\n'
    )
    result = subprocess.run([BASH, "fallback.sh"], cwd=tmp_path,
                            env={**os.environ, "HOME": str(tmp_path / "home"), "USERPROFILE": str(tmp_path / "home")},
                            capture_output=True)
    assert result.returncode == 0 and result.stdout.strip() == b"42", result.stderr
