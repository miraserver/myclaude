"""Exercise hook wire encoding independently of the console code page."""
import json
import subprocess
import sys
import tempfile
import uuid

import pytest

from test_hooks import HOOKS_DIR, activate, build_hook_env, write_tasks


TITLE = "Задача 中文 \U0001f680"
HOOKS = sorted(HOOKS_DIR.glob("*-*.py"))


def run_encoded(command, payload, encoding, bom=False, env_extra=None):
    env = build_hook_env(env_extra)
    env["PYTHONIOENCODING"] = encoding
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if bom:
        raw = b"\xef\xbb\xbf" + raw
    with tempfile.TemporaryDirectory() as isolated_cwd:
        env.update({"TMP": isolated_cwd, "TEMP": isolated_cwd, "TMPDIR": isolated_cwd})
        proc = subprocess.run(
            [sys.executable, *map(str, command)],
            cwd=isolated_cwd,
            input=raw, capture_output=True, env=env, timeout=10,
        )
    # Never let the test runner's locale decide how to decode hook output.
    return proc.returncode, proc.stdout.decode("utf-8"), proc.stderr.decode("utf-8")


@pytest.mark.parametrize("script", HOOKS, ids=lambda p: p.stem)
@pytest.mark.parametrize("encoding", ["cp1252", "cp1251", "ascii"])
@pytest.mark.parametrize("bom", [False, True], ids=["utf8", "utf8-bom"])
def test_hook_utf8_payload_and_ascii_json(tmp_path, script, encoding, bom):
    root = tmp_path / TITLE
    root.mkdir()
    activate(root)
    status = {
        "harness-subagentstop.py": "in_progress",
        "harness-renew.py": "in_progress",
        "harness-teammateidle.py": "completed",
    }.get(script.name, "pending")
    write_tasks(root, [{
        "id": TITLE, "title": TITLE, "status": status,
        "claimed_by": "worker", "depends_on": [],
    }])
    transcript = root / "对话.jsonl"
    transcript.write_text(
        json.dumps({"role": "user", "content": TITLE}, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    (root / ".harness-reflect").touch()
    session_id = "encoding-" + uuid.uuid4().hex
    payload = {
        "cwd": str(root), "title": TITLE, "task_id": TITLE,
        "transcript_path": str(transcript), "session_id": session_id,
    }
    code, stdout, stderr = run_encoded(
        [script], payload, encoding, bom,
        {"HARNESS_WORKER_ID": "worker", "REFLECT_MAX_ITERATIONS": "5"},
    )
    assert code == 0, stderr
    assert stderr == ""
    if script.name == "harness-teammateidle.py":
        assert stdout == ""  # This hook uses stderr and exit 2 to block.
    else:
        assert stdout.isascii()
        data = json.loads(stdout)
        text = data.get("reason", data.get("title", data.get("task_id")))
        if script.name == "harness-sessionstart.py":
            text = data["hookSpecificOutput"]["additionalContext"]
        assert TITLE in text


@pytest.mark.parametrize("encoding", ["cp1252", "cp1251", "ascii"])
@pytest.mark.parametrize("status", ["pending", "in_progress"])
def test_teammateidle_diagnostics_do_not_crash(tmp_path, encoding, status):
    root = tmp_path / TITLE
    root.mkdir()
    activate(root)
    write_tasks(root, [{
        "id": "task", "title": TITLE, "status": status,
        "claimed_by": TITLE, "depends_on": [],
    }])
    code, stdout, stderr = run_encoded(
        [HOOKS_DIR / "harness-teammateidle.py"],
        {"cwd": str(root), "teammate_name": TITLE}, encoding, bom=True,
    )
    assert code == 2, stderr
    assert stdout == ""
    assert TITLE in stderr
    assert "\\u" not in stderr


@pytest.mark.parametrize("encoding", ["cp1252", "cp1251", "ascii"])
@pytest.mark.parametrize("corrupt", [False, True])
def test_stop_safety_valve_diagnostics_do_not_crash(tmp_path, encoding, corrupt):
    activate(tmp_path)
    write_tasks(tmp_path, [{"id": "task", "title": TITLE, "status": "pending"}])
    if corrupt:
        (tmp_path / "harness-tasks.json").write_text("{", encoding="utf-8")
    else:
        (tmp_path / ".harness-stop-counter").write_text("9,0", encoding="utf-8")
    code, stdout, stderr = run_encoded(
        [HOOKS_DIR / "harness-stop.py"],
        {"cwd": str(tmp_path), "stop_hook_active": True}, encoding,
    )
    assert code == 0, stderr
    assert stdout == ""
    assert "WARN" in stderr
    assert "无法解析" in stderr if corrupt else "Allowing stop" in stderr
    assert "\\u" not in stderr


@pytest.mark.parametrize("helper", ["emit_block", "emit_allow", "emit_context", "emit_json"])
@pytest.mark.parametrize("encoding", ["cp1252", "cp1251", "ascii"])
def test_common_payload_and_output_helpers(helper, encoding):
    code = (
        "import sys; sys.path.insert(0, sys.argv[1]); "
        "import _harness_common as hc; payload = hc.read_hook_payload(); "
        "getattr(hc, sys.argv[2])(payload if sys.argv[2] == 'emit_json' else payload['title'])"
    )
    payload = {"cwd": TITLE, "title": TITLE}
    status, stdout, stderr = run_encoded(["-c", code, HOOKS_DIR, helper], payload, encoding, bom=True)
    assert status == 0, stderr
    assert stderr == ""
    assert stdout.isascii()
    data = json.loads(stdout)
    if helper == "emit_json":
        assert data == payload
    elif helper == "emit_context":
        assert data["hookSpecificOutput"]["additionalContext"] == TITLE
    else:
        assert data["reason"] == TITLE
