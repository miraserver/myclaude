"""CLI and hook failures must not leak registry tracebacks into sessions."""
import importlib.util
import json
from pathlib import Path
import sys

import pytest


HARNESS = Path(__file__).resolve().parents[1]


def load_script(relative):
    spec = importlib.util.spec_from_file_location("failure_under_test", HARNESS / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("command", ["activate", "deactivate"])
@pytest.mark.parametrize("error", [TimeoutError("registry lock timed out"), OSError("access denied")])
def test_activation_failure_is_one_line(tmp_path, monkeypatch, capsys, command, error):
    activation = load_script("scripts/activation.py")

    def fail(root):
        assert root == tmp_path
        raise error

    monkeypatch.setattr(activation, command + "_harness", fail)
    monkeypatch.setattr(sys, "argv", ["activation.py", command, str(tmp_path)])
    with pytest.raises(SystemExit) as exit_info:
        activation.main()
    assert exit_info.value.code == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == f"harness activation failed: {error}\n"


@pytest.mark.parametrize("marker_session,count", [("old-session", 0), ("current-session", 5)])
def test_reflection_cleanup_timeout_is_silent(tmp_path, monkeypatch, capsys, marker_session, count):
    hook = load_script("hooks/self-reflect-stop.py")
    marker = tmp_path / ".harness-reflect"
    marker.write_text(json.dumps({"session_id": marker_session, "count": count}), encoding="utf-8")
    monkeypatch.setattr(hook.hc, "read_hook_payload", lambda: {"session_id": "current-session"})
    monkeypatch.setattr(hook, "_find_harness_root", lambda payload: tmp_path)
    monkeypatch.setenv("REFLECT_MAX_ITERATIONS", "5")
    calls = []

    def fail(root):
        calls.append(root)
        raise TimeoutError("registry lock timed out")

    monkeypatch.setattr(hook.hc, "clear_reflection", fail)
    assert hook.main() == 0
    assert calls == [tmp_path]
    assert not marker.exists()
    captured = capsys.readouterr()
    assert (captured.out, captured.err) == ("", "")
