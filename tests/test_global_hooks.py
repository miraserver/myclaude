"""Global hook regression tests; all subprocesses use disposable homes/cwds."""
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import pytest

HOOKS = Path(__file__).resolve().parents[1] / "hooks"


def test_registered_hooks_are_pre_bash_only():
    manifest = json.loads((HOOKS / "hooks.json").read_text(encoding="utf-8"))
    assert manifest["hooks"] == {
        "PreToolUse": [{
            "matcher": "Bash",
            "hooks": [{
                "type": "command",
                "command": 'python3 "${CLAUDE_PLUGIN_ROOT}/pre-bash.py"',
            }],
        }],
    }


def test_registered_command_paths_exist():
    manifest = json.loads((HOOKS / "hooks.json").read_text(encoding="utf-8"))
    for entries in manifest["hooks"].values():
        for entry in entries:
            for hook in entry["hooks"]:
                if hook["type"] == "command":
                    prefix = 'python3 "${CLAUDE_PLUGIN_ROOT}/'
                    command = hook["command"]
                    assert command.startswith(prefix) and command.endswith('"')
                    script = (HOOKS / command[len(prefix):-1]).resolve()
                    assert script.is_relative_to(HOOKS.resolve())
                    assert script.is_file(), script


def run(tmp_path, script, payload):
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home), "CLAUDE_CODE_SSE_PORT": "test"}
    return subprocess.run([sys.executable, str(HOOKS / script)], input=payload.encode(), cwd=tmp_path, env=env, capture_output=True)


@pytest.mark.parametrize("command", [
    "rm -rf /", "rm -fr /*", "rm -r -f ~", "rm -f -r ~/", "rm -rf ~/*", 'rm -rf "$HOME"',
    "rm --force --recursive /", "rm -Rf -- /", "true; rm -fr /", "true\nrm -rf /",
    "dd if=a of=/dev/sda", "dd of=/dev/nvme0n1 if=a", "mkfs.ext4 /dev/sda", ":(){ :|:& };:",
    "echo x >/dev/sda", "echo x 2>>/dev/sdb1",
])
def test_blocks(tmp_path, command):
    result = run(tmp_path, "pre-bash.py", json.dumps({"tool_input": {"command": command}}))
    assert result.returncode == 2
    assert b"BLOCKED" in result.stderr


@pytest.mark.parametrize("command", [
    "rm -rf /tmp/x", "rm -rf ./build", "dd if=a of=b", "dd if=a of=/dev/null",
    "rm -r /", "rm -f /", "rm -rf ~/cache", "echo 'rm -rf /'", "echo mkfs.ext4",
    "echo x > /tmp/sda", "rm -rf /tmp/x /tmp/y",
])
def test_allows(tmp_path, command):
    assert run(tmp_path, "pre-bash.py", json.dumps({"tool_input": {"command": command}})).returncode == 0


@pytest.mark.parametrize("payload", ["", "{", "[]", "null", '{"tool_input": null}', '{"tool_input":{"command":42}}'])
def test_malformed(tmp_path, payload):
    assert run(tmp_path, "pre-bash.py", payload).returncode == 0


def test_prompt_home_private(tmp_path):
    result = run(tmp_path, "log-prompt.py", json.dumps({"prompt": "private prompt"}))
    assert result.returncode == 0, result.stderr
    log = tmp_path / "home/.claude/state/session-test.log"
    assert "private prompt" in log.read_text()
    assert not (tmp_path / ".claude").exists()
    if os.name == "posix":
        assert stat.S_IMODE(log.stat().st_mode) == 0o600
        log.chmod(0o644)
        run(tmp_path, "log-prompt.py", json.dumps({"prompt": "second"}))
        assert stat.S_IMODE(log.stat().st_mode) == 0o600


@pytest.mark.parametrize("encoding", ["cp1251", "cp1252"])
def test_utf8_payload_under_ansi_stdio(tmp_path, monkeypatch, encoding):
    monkeypatch.setenv("PYTHONIOENCODING", encoding)
    payload = json.dumps({"tool_input": {"command": "rm -rf /  # комментарий 😀"}}, ensure_ascii=False)
    assert run(tmp_path, "pre-bash.py", payload).returncode == 2


def test_bom_payload_blocks_dangerous_command(tmp_path):
    payload = '\ufeff' + json.dumps({"tool_input": {"command": "rm -rf /"}})
    assert run(tmp_path, "pre-bash.py", payload).returncode == 2


def test_bom_prompt_logs_decoded_prompt(tmp_path):
    result = run(tmp_path, "log-prompt.py", '\ufeff' + json.dumps({"prompt": "BOM prompt"}))
    assert result.returncode == 0, result.stderr
    log = (tmp_path / "home/.claude/state/session-test.log").read_text(encoding="utf-8")
    assert log.split("] ", 1)[1] == "BOM prompt\n"
