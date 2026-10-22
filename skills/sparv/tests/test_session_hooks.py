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
