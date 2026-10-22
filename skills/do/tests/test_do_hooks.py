from __future__ import annotations

import base64
import copy
import importlib.util
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
HOOK = ROOT / "hooks" / "stop-hook.py"
SETUP = ROOT / "scripts" / "setup-do.py"
sys.path.insert(0, str(SCRIPTS))
import task

HOOK_SPEC = importlib.util.spec_from_file_location("do_stop_hook", HOOK)
stop_hook = importlib.util.module_from_spec(HOOK_SPEC)
HOOK_SPEC.loader.exec_module(stop_hook)


def python_command(code):
    encoded = base64.b64encode(code.encode("utf-8")).decode("ascii")
    command = f"import base64;exec(base64.b64decode('{encoded}'))"
    executable = f'"{sys.executable}"' if os.name == "nt" else shlex.quote(sys.executable)
    quoted_code = f'"{command}"' if os.name == "nt" else shlex.quote(command)
    return f"{executable} -c {quoted_code}"


class DoHookTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.project = Path(self.temp_dir.name).resolve()
        self.home = self.project / "isolated-home"
        self.home.mkdir()
        (self.project / ".claude").mkdir()
        project_patcher = patch.dict(os.environ, {
            "CLAUDE_PROJECT_DIR": str(self.project),
            "HOME": str(self.home), "USERPROFILE": str(self.home),
        })
        project_patcher.start()
        self.addCleanup(project_patcher.stop)
        self.environment = os.environ.copy()
        self.environment.pop("CLAUDE_PROJECT_DIR", None)
        self.environment["CLAUDE_PROJECT_DIR"] = str(self.project)
        for arguments in (
            ["init"],
            ["-c", "user.name=Do Test", "-c", "user.email=do@example.test",
             "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "test root"],
        ):
            subprocess.run(
                ["git", *arguments], cwd=self.project, env=self.environment,
                check=True, capture_output=True, text=True,
            )
        self.session_id = "session-a"

    def test_utf8_payload_under_ansi_stdio(self):
        self._create_task("unfinished")
        for encoding in ("cp1251", "cp1252"):
            payload = {"cwd": str(self.project), "session_id": "комментарий 😀"}
            result = subprocess.run(
                [sys.executable, str(HOOK)],
                input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                env={**self.environment, "PYTHONIOENCODING": encoding},
                capture_output=True, cwd=self.project,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["decision"], "block")

    def tearDown(self):
        self.temp_dir.cleanup()

    def _create_task(self, title="test task"):
        result = task.create_task(title)
        return Path(result["task_dir"])

    def _read_task(self, task_dir=None):
        current = task_dir or self._current_task_dir()
        parsed = task.read_task_md(str(current / "task.md"))
        self.assertIsNotNone(parsed)
        return parsed["frontmatter"], parsed["body"]

    def _write_task(self, frontmatter, body, task_dir=None):
        current = task_dir or self._current_task_dir()
        self.assertTrue(task.write_task_md(str(current / "task.md"), frontmatter, body))

    def _current_task_dir(self):
        relative = task.get_current_task(str(self.project))
        self.assertIsNotNone(relative)
        return self.project / relative

    def _set_task(self, **values):
        if "verify_command" in values:
            self.assertTrue(task.set_verify(values["verify_command"]))
        frontmatter, body = self._read_task()
        frontmatter.update(values)
        self._write_task(frontmatter, body)

    def _stop(self, payload=None, environment=None, timeout=8):
        data = {"hook_event_name": "Stop", "session_id": self.session_id, "cwd": str(self.project)}
        if payload:
            data.update(payload)
        env = self.environment.copy()
        if environment:
            env.update(environment)
        return subprocess.run(
            [sys.executable, str(HOOK)],
            cwd=self.project,
            env=env,
            input=json.dumps(data),
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )

    def _stop_json(self, payload=None, environment=None):
        result = self._stop(payload, environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout == "" or json.loads(result.stdout))
        return result, json.loads(result.stdout) if result.stdout else {}

    def _setup(self, *arguments):
        return subprocess.run(
            [sys.executable, str(SETUP), *arguments],
            cwd=self.project,
            env=self.environment,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=8,
        )

    def _task_cli(self, *arguments):
        return subprocess.run(
            [sys.executable, str(SCRIPTS / "task.py"), *arguments],
            cwd=self.project,
            env=self.environment,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=8,
        )

    def _read_stop_state(self):
        state_path = self.project / ".claude" / "do-tasks" / task.STATE_FILE
        return json.loads(state_path.read_text(encoding="utf-8"))

    def test_no_current_task_allows_with_empty_stdout(self):
        result = self._stop()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_phase_two_of_five_same_bound_session_blocks_with_finish_reason(self):
        self._create_task()
        self._set_task(current_phase=2, max_phases=5, phase_name="Clarify", session_id=self.session_id)
        result, output = self._stop_json()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(output.get("decision"), "block")
        self.assertIn("phase 2/5", output.get("reason", ""))
        self.assertIn("Clarify", output.get("reason", ""))
        self.assertIn("task.py finish", output.get("reason", ""))

    def test_phase_two_of_five_other_bound_session_allows(self):
        self._create_task()
        self._set_task(current_phase=2, max_phases=5, phase_name="Clarify", session_id="session-b")
        result = self._stop()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_first_stop_persists_session_id_into_task_md(self):
        self._create_task()
        self._set_task(current_phase=2, max_phases=5, phase_name="Clarify")
        result = self._stop()
        self.assertEqual(result.returncode, 0)
        frontmatter, _ = self._read_task()
        self.assertEqual(frontmatter.get("session_id"), self.session_id)

    def test_incomplete_phase_blocks_five_stops_then_emits_only_system_message(self):
        self._create_task()
        self._set_task(current_phase=2, max_phases=5, phase_name="Clarify")
        for _ in range(5):
            result, output = self._stop_json()
            self.assertEqual(result.returncode, 0)
            self.assertEqual(output.get("decision"), "block")
        result, output = self._stop_json()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(set(output), {"systemMessage"})
        self.assertTrue(output["systemMessage"])
        self.assertEqual(self._read_stop_state().get("blocks"), 5)

    def test_advancing_incomplete_phase_resets_exhausted_stop_budget(self):
        self._create_task()
        self._set_task(current_phase=2, max_phases=5, phase_name="Clarify")
        for _ in range(5):
            self.assertEqual(self._stop_json()[1].get("decision"), "block")
        self.assertEqual(self._read_stop_state()["blocks"], 5)
        self._set_task(current_phase=3, phase_name="Design")
        _, output = self._stop_json()
        self.assertEqual(output.get("decision"), "block")
        self.assertIn("phase 3/5", output.get("reason", ""))
        self.assertEqual(self._read_stop_state()["phase"], 3)
        self.assertEqual(self._read_stop_state()["blocks"], 1)

    def test_final_phase_verification_gets_fresh_budget_after_incomplete_blocks(self):
        self._create_task()
        self._set_task(current_phase=2, max_phases=5, phase_name="Clarify")
        for _ in range(5):
            self.assertEqual(self._stop_json()[1].get("decision"), "block")
        self.assertEqual(self._read_stop_state()["blocks"], 5)
        self._set_task(
            current_phase=5,
            phase_name="Complete",
            verify_command=python_command("import sys;sys.exit(7)"),
        )
        _, output = self._stop_json()
        self.assertEqual(output.get("decision"), "block")
        self.assertIn("attempt 1/5", output.get("reason", ""))
        frontmatter, _ = self._read_task()
        self.assertNotEqual(frontmatter.get("status"), "verify_failed")
        self.assertEqual(self._read_stop_state()["phase"], 5)
        self.assertEqual(self._read_stop_state()["blocks"], 1)

    def test_legacy_stop_state_without_phase_gets_fresh_budget(self):
        current = self._create_task()
        self._set_task(current_phase=2, max_phases=5, phase_name="Clarify")
        state_path = self.project / ".claude" / "do-tasks" / task.STATE_FILE
        state_path.write_text(
            json.dumps({"task": os.path.relpath(current, self.project), "blocks": 5}),
            encoding="utf-8",
        )
        _, output = self._stop_json()
        self.assertEqual(output.get("decision"), "block")
        self.assertEqual(
            self._read_stop_state(),
            {"task": os.path.relpath(current, self.project), "phase": 2, "blocks": 1},
        )

    def test_switching_current_task_resets_stop_state_task_and_blocks(self):
        first = self._create_task("first")
        for _ in range(3):
            self.assertEqual(self._stop_json()[1].get("decision"), "block")
        self.assertEqual(
            self._read_stop_state(),
            {"task": os.path.relpath(first, self.project), "phase": 1, "blocks": 3},
        )
        second = self._create_task("second")
        result, output = self._stop_json()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(output.get("decision"), "block")
        self.assertEqual(
            self._read_stop_state(),
            {"task": os.path.relpath(second, self.project), "phase": 1, "blocks": 1},
        )

    def test_set_verify_cli_round_trips_then_clears_and_preserves_body(self):
        self._create_task()
        _, original_body = self._read_task()
        command = 'echo "url:http://example.test/a:b" && echo "C:\\Temp\\quoted value"'
        result = self._task_cli("set-verify", command)
        self.assertEqual(result.returncode, 0, result.stderr)
        frontmatter, body = self._read_task()
        self.assertEqual(frontmatter.get("verify_command"), command)
        self.assertEqual(body, original_body)
        result = self._task_cli("set-verify", "")
        self.assertEqual(result.returncode, 0, result.stderr)
        frontmatter, body = self._read_task()
        self.assertEqual(frontmatter.get("verify_command"), "")
        self.assertEqual(body, original_body)
        self._set_task(current_phase=5, max_phases=5, phase_name="Complete")
        result, output = self._stop_json()
        self.assertEqual(result.returncode, 0)
        self.assertNotEqual(output.get("decision"), "block")
        frontmatter, body = self._read_task()
        self.assertEqual(frontmatter.get("status"), "completed")
        self.assertEqual(body, original_body)

    def test_phase_five_without_command_allows_and_marks_completed(self):
        self._create_task()
        self._set_task(current_phase=5, max_phases=5, phase_name="Complete")
        result = self._stop()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        frontmatter, _ = self._read_task()
        self.assertEqual(frontmatter.get("status"), "completed")

    def test_cancelled_task_neither_blocks_nor_verifies(self):
        self._create_task()
        self._set_task(
            status="cancelled", current_phase=5,
            verify_command=python_command(
                "from pathlib import Path;Path('unexpected-verify').touch()"
            ),
        )
        before = self._read_task()
        result = self._stop()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertFalse((self.project / "unexpected-verify").exists())
        self.assertFalse((self.project / task.DIR_TASKS / task.STATE_FILE).exists())
        self.assertEqual(self._read_task(), before)

    def test_set_verify_restarts_failed_task_with_fresh_budget(self):
        self._create_task()
        for exit_code in (7, 0):
            with self.subTest(exit_code=exit_code):
                self._set_task(status="verify_failed", current_phase=5,
                               session_id=self.session_id)
                state_path = self.project / task.DIR_TASKS / task.STATE_FILE
                state_path.write_text(json.dumps({
                    "task": os.path.relpath(self._current_task_dir(), self.project),
                    "phase": 5, "blocks": 5,
                }), encoding="utf-8")
                command = python_command(
                    "from pathlib import Path;import sys;"
                    "Path('restarted-verify').write_text('ran');"
                    f"sys.exit({exit_code})"
                )
                result = self._task_cli("set-verify", command)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self._read_task()[0]["status"], "in_progress")
                self.assertFalse(state_path.exists())
                _, output = self._stop_json()
                self.assertEqual((self.project / "restarted-verify").read_text(), "ran")
                (self.project / "restarted-verify").unlink()
                if exit_code:
                    self.assertEqual(output.get("decision"), "block")
                    self.assertIn("attempt 1/5", output["reason"])
                    self.assertEqual(self._read_stop_state()["blocks"], 1)
                    self.assertEqual(self._read_task()[0]["status"], "in_progress")
                else:
                    self.assertEqual(output, {})
                    self.assertEqual(self._read_task()[0]["status"], "completed")
                    self.assertEqual(self._read_stop_state()["blocks"], 0)

    def test_set_verify_preserves_other_statuses_and_stop_state(self):
        self._create_task()
        state_path = self.project / task.DIR_TASKS / task.STATE_FILE
        for status in ("in_progress", "completed", "cancelled"):
            with self.subTest(status=status):
                self._set_task(status=status)
                state_path.write_text('{"blocks": 3}', encoding="utf-8")
                before = state_path.read_bytes()
                result = self._task_cli("set-verify", "echo changed")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self._read_task()[0]["status"], status)
                self.assertEqual(state_path.read_bytes(), before)

    def test_phase_five_passing_command_runs_once_and_completes(self):
        marker = self.project / "marker.txt"
        code = (
            f"from pathlib import Path; path_obj=Path({str(marker)!r}); "
            "path_obj.write_text(path_obj.read_text() + 'verified\\n' if path_obj.exists() else 'verified\\n')"
        )
        self._create_task()
        self._set_task(
            current_phase=5,
            max_phases=5,
            phase_name="Complete",
            verify_command=python_command(code),
        )
        first = self._stop()
        second = self._stop()
        self.assertEqual(first.stdout, "")
        self.assertEqual(second.stdout, "")
        self.assertEqual(marker.read_text(encoding="utf-8").splitlines(), ["verified"])
        frontmatter, _ = self._read_task()
        self.assertEqual(frontmatter.get("status"), "completed")

    def test_failing_command_blocks_with_exit_code_and_tail_and_one_attempt(self):
        code = "import sys;sys.stdout.write('HEAD\\n' + 'x' * 4000 + '\\nTAIL\\n');sys.exit(7)"
        self._create_task()
        self._set_task(
            current_phase=5,
            max_phases=5,
            phase_name="Complete",
            verify_command=python_command(code),
        )
        _, output = self._stop_json()
        reason = output.get("reason", "")
        self.assertEqual(output.get("decision"), "block")
        self.assertIn("exit 7", reason)
        self.assertIn("TAIL", reason)
        self.assertNotIn("HEAD", reason)
        state = self._read_stop_state()
        self.assertEqual(state.get("blocks"), 1)
        expected_task = os.path.relpath(self._current_task_dir(), self.project).replace("\\", "/")
        self.assertEqual(state.get("task", "").replace("\\", "/"), expected_task)

    def test_fifth_persistent_failure_allows_system_message_and_marks_verify_failed(self):
        attempt_log = self.project / "verify-attempts.txt"
        code = (
            "import sys;from pathlib import Path;"
            "attempt_log=Path('verify-attempts.txt');"
            "attempt_log.write_text(attempt_log.read_text() + 'attempt\\n' "
            "if attempt_log.exists() else 'attempt\\n');"
            "sys.stderr.write('failure');sys.exit(3)"
        )
        self._create_task()
        self._set_task(
            current_phase=5,
            max_phases=5,
            phase_name="Complete",
            verify_command=python_command(code),
        )
        outputs = [self._stop_json()[1] for _ in range(5)]
        for output in outputs[:4]:
            self.assertEqual(output.get("decision"), "block")
        self.assertNotIn("decision", outputs[-1])
        self.assertIn(
            "verification still failing after 5 attempts:",
            outputs[-1].get("systemMessage", ""),
        )
        frontmatter, _ = self._read_task()
        self.assertEqual(frontmatter.get("status"), "verify_failed")
        self.assertEqual(self._read_stop_state().get("blocks"), 5)
        self.assertEqual(attempt_log.read_text(encoding="utf-8").splitlines(), ["attempt"] * 5)
        result = self._stop()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(attempt_log.read_text(encoding="utf-8").splitlines(), ["attempt"] * 5)
        self.assertEqual(self._read_stop_state().get("blocks"), 5)

    def test_verify_timeout_blocks(self):
        self._create_task()
        self._set_task(
            current_phase=5,
            max_phases=5,
            phase_name="Complete",
            verify_command=python_command("import time;time.sleep(3)"),
        )
        _, output = self._stop_json(environment={"DO_VERIFY_TIMEOUT": "1"})
        self.assertEqual(output.get("decision"), "block")
        self.assertIn("timed out", output.get("reason", "").lower())

    def test_verify_timeout_kills_grandchild_holding_stdout(self):
        self._create_task()
        pid_file = self.project / "grandchild.pid"
        code = (
            "import subprocess,sys,time;from pathlib import Path;"
            "child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);"
            "Path('grandchild.pid').write_text(str(child.pid));"
            "print('before timeout',flush=True);time.sleep(60)"
        )
        self._set_task(current_phase=5, verify_command=python_command(code))
        started = time.monotonic()
        try:
            result = self._stop(environment={"DO_VERIFY_TIMEOUT": "2"}, timeout=15)
            self.assertLess(time.monotonic() - started, 15)
            self.assertEqual(result.returncode, 0, result.stderr)
            output = json.loads(result.stdout)
            self.assertEqual(output.get("decision"), "block")
            self.assertIn("Verification timed out after 2 seconds.", output["reason"])
            self.assertIn("before timeout", output["reason"])
            pid = int(pid_file.read_text())
            if os.name == "nt":
                listing = subprocess.run(
                    ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                    capture_output=True, text=True, timeout=5,
                )
                self.assertEqual(listing.returncode, 0, listing.stderr)
                self.assertNotIn(f'"{pid}"', listing.stdout)
            else:
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
        finally:
            if pid_file.exists():
                pid = int(pid_file.read_text())
                if os.name == "nt":
                    subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)],
                                   capture_output=True, timeout=5)
                else:
                    try:
                        os.kill(pid, 9)
                    except ProcessLookupError:
                        pass

    def _load_stop_hook(self):
        spec = importlib.util.spec_from_file_location("do_stop_hook", HOOK)
        hook = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hook)
        return hook

    def test_timeout_output_collection_is_bounded_even_if_process_stays_alive(self):
        hook = self._load_stop_hook()
        captured = []

        def start_process(*args, **kwargs):
            captured.append(kwargs["stdout"])
            kwargs["stdout"].write(b"partial output\nmore\xff")
            return proc

        with patch.object(hook.subprocess, "Popen") as popen, \
                patch.object(hook.subprocess, "run") as taskkill, \
                patch.dict(os.environ, {"DO_VERIFY_TIMEOUT": "2"}):
            proc = popen.return_value
            proc.pid = 12345
            proc.wait.side_effect = [
                subprocess.TimeoutExpired("verify", 2),
                subprocess.TimeoutExpired("verify", 5),
            ]
            popen.side_effect = start_process
            with patch.object(hook.os, "killpg", create=True) as killpg:
                result = hook.run_verification("verify", str(self.project))
            self.assertEqual(result, (
                "timeout", "partial output\nmore\ufffd\nVerification timed out after 2 seconds.",
            ))
            self.assertEqual([call.kwargs for call in proc.wait.call_args_list],
                             [{"timeout": 2}, {"timeout": 5}])
            proc.communicate.assert_not_called()
            proc.stdout.close.assert_not_called()
            self.assertTrue(captured[0].closed)
            proc.kill.assert_called_once_with()
            if os.name == "nt":
                self.assertEqual(popen.call_args.kwargs["creationflags"],
                                 subprocess.CREATE_NEW_PROCESS_GROUP)
                taskkill.assert_called_once_with(
                    ["taskkill", "/T", "/F", "/PID", "12345"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
                )
            else:
                self.assertTrue(popen.call_args.kwargs["start_new_session"])
                killpg.assert_called_once_with(12345, hook.signal.SIGKILL)

    def test_verification_timeout_parsing(self):
        hook = self._load_stop_hook()
        for value, expected in ((None, 1500), ("", 1500), ("abc", 1500),
                                ("0", 1500), ("-5", 1500), ("60", 60),
                                ("3600", 1740)):
            with self.subTest(value=value), patch.dict(os.environ), \
                    patch("sys.stderr") as stderr:
                os.environ.pop("DO_VERIFY_TIMEOUT", None)
                if value is not None:
                    os.environ["DO_VERIFY_TIMEOUT"] = value
                self.assertEqual(hook._verify_timeout(), expected)
                if value in ("", "abc", "0", "-5"):
                    self.assertIn("Warning", "".join(
                        call.args[0] for call in stderr.write.call_args_list))
                else:
                    stderr.write.assert_not_called()

    def test_verification_captures_success_and_failure_output(self):
        hook = self._load_stop_hook()
        for exit_code in (0, 3):
            with self.subTest(exit_code=exit_code):
                command = python_command(f"import sys;print('hello');sys.exit({exit_code})")
                code, output = hook.run_verification(command, str(self.project))
                self.assertEqual(code, exit_code)
                self.assertIn("hello", output)
        self._create_task()
        self._set_task(current_phase=5, verify_command=command)
        _, output = self._stop_json()
        self.assertEqual(output.get("decision"), "block")
        self.assertIn("exit 3", output["reason"])
        self.assertIn("hello", output["reason"])

    def test_kill_tree_swallows_termination_errors(self):
        hook = self._load_stop_hook()
        with patch.object(hook.subprocess, "Popen") as popen, \
                patch.object(hook.subprocess, "run", side_effect=OSError), \
                patch.object(hook.os, "killpg", create=True, side_effect=OSError):
            proc = popen.return_value
            proc.pid = 12345
            proc.kill.side_effect = OSError
            hook._kill_tree(proc)
            proc.kill.assert_called_once_with()

    def test_install_and_uninstall_preserve_foreign_hooks(self):
        spec = importlib.util.spec_from_file_location("do_installer", ROOT / "install.py")
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        home = self.project / "temporary home"
        settings_path = home / ".claude" / "settings.json"
        installed_hook = home / ".claude" / "skills" / "do" / "hooks" / "stop-hook.py"
        foreign = {"type": "command", "command": "python3 ~/tools/stop-hook-docs.py",
                   "timeout": 12}
        for path in (installed_hook.as_posix(), str(installed_hook).replace("/", "\\"),
                     installer.HOOK_PATH):
            with self.subTest(path=path), \
                    patch.dict(os.environ, {"HOME": str(home), "USERPROFILE": str(home)}), \
                    patch.object(installer.Path, "home", return_value=home), \
                    patch.object(installer, "get_settings_path", return_value=settings_path):
                settings = {"hooks": {"Stop": [{"hooks": [copy.deepcopy(foreign), {
                    "type": "command", "command": f'python3 "{path}"', "timeout": 10,
                }]}]}, "other_setting": True}
                installer.save_settings(settings)
                installer.install()
                updated = installer.load_settings()
                hooks = updated["hooks"]["Stop"][0]["hooks"]
                self.assertEqual(hooks, [foreign, {
                    "type": "command", "command": f'python3 "{installed_hook.as_posix()}"',
                    "timeout": 1800,
                }])
                self.assertTrue(installed_hook.is_file())
                installer.uninstall()
                self.assertEqual(installer.load_settings(), {
                    "hooks": {"Stop": [{"hooks": [foreign]}]}, "other_setting": True,
                })
                self.assertFalse(installed_hook.exists())

    def test_installer_rejects_other_directories_and_hook_suffixes(self):
        spec = importlib.util.spec_from_file_location("do_installer", ROOT / "install.py")
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        with patch.dict(os.environ, {"HOME": str(self.project), "USERPROFILE": str(self.project)}), \
                patch.object(installer.Path, "home", return_value=self.project):
            installed = (self.project / ".claude/skills/do/hooks/stop-hook.py").as_posix()
            for command in (
                f'python3 "{installed}.bak"',
                'python3 "/other/skills/do/hooks/stop-hook.py"',
                'python3 ~/tools/stop-hook-docs.py',
            ):
                self.assertFalse(installer.is_do_hook(command), command)
            settings = {"hooks": {"Stop": [{"hooks": [{
                "type": "command", "command": "python3 ~/tools/stop-hook-docs.py",
            }]}]}}
            original = copy.deepcopy(settings)
            installer.add_hook(settings)
            self.assertEqual(len(settings["hooks"]["Stop"]), 2)
            self.assertEqual(installer.remove_hook(settings), original)

    def test_existing_worktree_dir_is_used_as_verify_cwd(self):
        worktree = self.project / "worktree"
        worktree.mkdir()
        output_file = self.project / "cwd.txt"
        code = f"from pathlib import Path;Path({str(output_file)!r}).write_text(__import__('os').getcwd())"
        self._create_task()
        self._set_task(
            current_phase=5,
            max_phases=5,
            phase_name="Complete",
            worktree_dir=str(worktree),
            verify_command=python_command(code),
        )
        self._stop_json()
        self.assertEqual(Path(output_file.read_text(encoding="utf-8")).resolve(), worktree.resolve())

    def test_worktree_falls_back_when_project_is_not_a_git_repo(self):
        worktree = self.project / "worktree"
        worktree.mkdir()
        project = self.project / "not-a-repository"
        project.mkdir()
        loaded = (str(self.project / "task.md"), {"worktree_dir": str(worktree)}, "")
        with patch.object(stop_hook.subprocess, "run", side_effect=subprocess.CalledProcessError(128, "git")), \
                patch.object(stop_hook, "run_verification", return_value=(0, "")) as verify, \
                patch.object(stop_hook, "save_task"), patch.object(stop_hook, "save_state"):
            stop_hook.verify_task(loaded, str(project), str(self.project / "state.json"),
                                  {"blocks": 0}, "true")
        self.assertEqual(verify.call_args.args[1], str(worktree))

    def test_unregistered_repo_task_is_ignored_without_binding_or_execution(self):
        directory = self.project / task.DIR_TASKS / "crafted"
        directory.mkdir(parents=True)
        Path(task.get_current_task_file(str(self.project))).write_text(
            str(directory.relative_to(self.project)), encoding="utf-8")
        command = python_command("from pathlib import Path;Path('untrusted-command').touch()")
        for phase in (1, 5):
            with self.subTest(phase=phase):
                self._write_task({"current_phase": phase, "max_phases": 5,
                                  "verify_command": command, "status": "in_progress",
                                  "session_id": ""}, "untrusted body", directory)
                before = (directory / "task.md").read_bytes()
                result = self._stop()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertEqual((directory / "task.md").read_bytes(), before)
                self.assertFalse((self.project / "untrusted-command").exists())
                self.assertFalse((self.project / task.DIR_TASKS / task.STATE_FILE).exists())

    def test_registry_command_overrides_repo_frontmatter(self):
        self._create_task()
        trusted = python_command("from pathlib import Path;Path('trusted-command').touch()")
        self.assertTrue(task.set_verify(trusted))
        frontmatter, body = self._read_task()
        frontmatter.update(current_phase=5, verify_command=python_command(
            "from pathlib import Path;Path('untrusted-command').touch()"))
        self._write_task(frontmatter, body)
        result = self._stop()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertTrue((self.project / "trusted-command").is_file())
        self.assertFalse((self.project / "untrusted-command").exists())
        self.assertEqual(self._read_task()[0]["status"], "completed")

    def test_corrupt_registry_ignores_task_and_preserves_repairable_data(self):
        self._create_task()
        self._set_task(current_phase=5, verify_command=python_command(
            "from pathlib import Path;Path('registered-command').touch()"))
        before = self._read_task()
        for content in ("{broken", "[]", "null", '{"project": []}',
                        '{"project": {"task": {"verify_command": 42}}}'):
            with self.subTest(content=content):
                task.registry_path().write_text(content, encoding="utf-8")
                result = self._stop()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertIn("Warning", result.stderr)
                self.assertEqual(self._read_task(), before)
                self.assertFalse((self.project / "registered-command").exists())
        with self.assertRaises(ValueError):
            task.register_task(str(self.project), str(self._current_task_dir() / "task.md"), "echo safe", "now")
        self.assertEqual(task.registry_path().read_text(encoding="utf-8"), content)
        task.registry_path().write_text("{}", encoding="utf-8")
        self.assertTrue(task.set_verify(before[0]["verify_command"]))
        self.assertEqual(self._stop().returncode, 0)
        self.assertTrue((self.project / "registered-command").is_file())

    def test_registry_is_user_local_and_scoped_to_resolved_project(self):
        directory = self._create_task()
        registry = json.loads(task.registry_path().read_text(encoding="utf-8"))
        self.assertEqual(task.registry_path(), self.home / ".claude/do-state/registry.json")
        self.assertEqual(registry[str(self.project.resolve())][directory.name], {
            "verify_command": "", "created_at": self._read_task()[0]["created_at"],
        })
        self.assertIsNotNone(task.registered_task(str(self.project / ".claude" / ".."),
                                                str(directory / "task.md")))
        other = self.project / "other-project"
        shutil.copytree(self.project / ".claude/do-tasks", other / ".claude/do-tasks")
        result = self._stop(environment={"CLAUDE_PROJECT_DIR": str(other)})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(task.read_task_md(str(other / directory.relative_to(self.project) / "task.md"))
                         ["frontmatter"]["session_id"], "")

    def test_registry_write_uses_atomic_replace_and_preserves_previous_on_failure(self):
        self._create_task()
        before = task.registry_path().read_bytes()
        with patch.object(task.os, "replace", side_effect=OSError("replace failed")) as replace:
            self.assertFalse(task.set_verify("echo changed"))
        replace.assert_called_once()
        source, destination = replace.call_args.args
        self.assertEqual(source.parent, task.registry_path().parent)
        self.assertEqual(destination, task.registry_path())
        self.assertFalse(source.exists())
        self.assertEqual(task.registry_path().read_bytes(), before)

    def test_stop_verifies_in_worktree_project_subdirectory(self):
        git_root = self.project
        project = git_root / "pkg" / "app"
        project.mkdir(parents=True)
        (project / "tracked.txt").write_text("tracked", encoding="utf-8")
        for args in (["add", "pkg/app/tracked.txt"],
                     ["-c", "user.name=Do Test", "-c", "user.email=do@example.test",
                      "-c", "commit.gpgsign=false", "commit", "-m", "nested project"]):
            subprocess.run(["git", *args], cwd=git_root, env=self.environment,
                           capture_output=True, text=True, check=True)
        self.project = project
        self.environment["CLAUDE_PROJECT_DIR"] = str(project)
        with patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": str(project)}):
            self._create_task()
            self._set_task(current_phase=5, verify_command=python_command(
                "from pathlib import Path;Path('verify-cwd.txt').write_text(str(Path.cwd()))"))
            attached = self._task_cli("worktree")
            self.assertEqual(attached.returncode, 0, attached.stderr)
            worktree = Path(self._read_task()[0]["worktree_dir"])
            result = self._stop()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "")
            expected = worktree / "pkg" / "app"
            self.assertEqual(Path((expected / "verify-cwd.txt").read_text()).resolve(),
                             expected.resolve())
            self.assertFalse((worktree / "verify-cwd.txt").exists())
            self.assertFalse((project / "verify-cwd.txt").exists())

    def test_attach_worktree_preserves_task_and_is_idempotent(self):
        current = self._create_task()
        self._set_task(
            current_phase=4, phase_name="Implement", max_phases=7,
            verify_command=python_command("print('verified')"),
            session_id=self.session_id, completion_promise="custom promise",
        )
        before, body = self._read_task()
        pointer = Path(task.get_current_task_file(str(self.project)))
        pointer_bytes = pointer.read_bytes()
        first = self._task_cli("worktree")
        self.assertEqual(first.returncode, 0, first.stderr)
        after, after_body = self._read_task(current)
        worktree = self.project / ".worktrees" / ("do-" + before["id"])
        self.assertTrue(worktree.is_dir())
        self.assertEqual(after, dict(before, use_worktree=True, worktree_dir=worktree.as_posix()))
        self.assertEqual(body, after_body)
        self.assertEqual(pointer.read_bytes(), pointer_bytes)
        metadata_bytes = (current / "task.md").read_bytes()
        second = self._task_cli("worktree")
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(first.stdout, second.stdout)
        self.assertEqual(first.stdout.strip(), "export DO_WORKTREE_DIR=" + worktree.as_posix())
        self.assertNotIn("\\", first.stdout)
        self.assertEqual((current / "task.md").read_bytes(), metadata_bytes)
        self.assertEqual(pointer.read_bytes(), pointer_bytes)
        self.assertEqual(list((self.project / ".worktrees").iterdir()), [worktree])
        self.assertEqual([p for p in current.parent.iterdir() if p.is_dir()], [current])
        listing = subprocess.run(
            ["git", "worktree", "list", "--porcelain"], cwd=self.project,
            env=self.environment, capture_output=True, text=True, check=True,
        )
        self.assertEqual(listing.stdout.count("worktree "), 2)
        self.assertIn("branch refs/heads/do/" + before["id"], listing.stdout)

    def test_attach_recreates_missing_worktree_on_existing_branch(self):
        self._create_task()
        attached = self._task_cli("worktree")
        self.assertEqual(attached.returncode, 0, attached.stderr)
        before, body = self._read_task()
        worktree = Path(before["worktree_dir"])
        subprocess.run(
            ["git", "-c", "user.name=Do Test", "-c", "user.email=do@example.test",
             "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "branch progress"],
            cwd=worktree, env=self.environment, capture_output=True, text=True, check=True,
        )
        tip = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=worktree, env=self.environment,
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        self.assertIn(self.project.resolve(), worktree.resolve().parents)
        shutil.rmtree(worktree)
        result = self._task_cli("worktree")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(worktree.is_dir())
        self.assertEqual(self._read_task(), (before, body))
        restored = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=worktree, env=self.environment,
            capture_output=True, text=True, check=True,
        )
        self.assertEqual(restored.stdout.strip(), tip)
        self.assertEqual(result.stdout, attached.stdout)

    def test_attach_missing_recorded_directory_creates_missing_branch(self):
        self._create_task()
        worktree = self.project / "custom-worktree"
        self._set_task(worktree_dir=worktree.as_posix())
        result = self._task_cli("worktree")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(worktree.is_dir())
        self.assertEqual(self._read_task()[0]["worktree_dir"], worktree.as_posix())

    def test_attach_requires_nonempty_frontmatter_id(self):
        current = self._create_task()
        original, body = self._read_task()
        for value in (None, "", "   "):
            with self.subTest(value=value):
                metadata = dict(original)
                if value is None:
                    metadata.pop("id")
                else:
                    metadata["id"] = value
                self._write_task(metadata, body, current)
                result = self._task_cli("worktree")
                self.assertEqual(result.returncode, 1)
                self.assertIn("non-empty id", result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                self.assertFalse((self.project / ".worktrees").exists())
                self.assertEqual(self._read_task(), (metadata, body))

    def test_attach_without_current_task_fails(self):
        result = self._task_cli("worktree")
        self.assertEqual(result.returncode, 1)
        self.assertIn("No active task", result.stderr)
        self.assertNotIn("export ", result.stdout)

    def test_attach_in_non_git_directory_fails_without_changing_task(self):
        self._create_task()
        before, body = self._read_task()
        # Hide only this temporary repository's metadata for the failure case.
        (self.project / ".git").rename(self.project / "git-metadata")
        result = self._task_cli("worktree")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Not a git repository", result.stderr)
        self.assertEqual(self._read_task(), (before, body))
        self.assertFalse((self.project / ".worktrees").exists())

    def test_stop_verification_runs_in_attached_worktree(self):
        self._create_task()
        self._set_task(verify_command=python_command(
            "from pathlib import Path;Path('attached-verification.txt').write_text(str(Path.cwd()))"
        ), session_id=self.session_id)
        attached = self._task_cli("worktree")
        self.assertEqual(attached.returncode, 0, attached.stderr)
        frontmatter, _ = self._read_task()
        worktree = Path(frontmatter["worktree_dir"])
        self.assertEqual(self._task_cli("update-phase", "5").returncode, 0)
        result, output = self._stop_json()
        self.assertEqual(output, {}, result.stderr)
        marker = worktree / "attached-verification.txt"
        self.assertEqual(Path(marker.read_text()).resolve(), worktree.resolve())
        self.assertFalse((self.project / marker.name).exists())
        self.assertEqual(self._read_task()[0]["status"], "completed")

    def test_setup_worktree_exports_and_cli_paths_use_forward_slashes(self):
        result = self._setup("--worktree", "new worktree task")
        self.assertEqual(result.returncode, 0, result.stderr)
        exports = [line for line in result.stdout.splitlines() if line.startswith("export ")]
        self.assertEqual(len(exports), 2)
        self.assertTrue(all("\\" not in line for line in exports))
        self.assertNotIn("\\", result.stdout)
        frontmatter, _ = self._read_task()
        self.assertTrue(frontmatter["use_worktree"])
        self.assertTrue(Path(frontmatter["worktree_dir"]).is_dir())
        status = self._task_cli("status")
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertNotIn("\\", status.stdout)
        current = self._current_task_dir()
        started = self._task_cli("start", str(current))
        self.assertEqual(started.returncode, 0, started.stderr)
        self.assertNotIn("\\", started.stdout)
        created = self._task_cli("create", "another task")
        self.assertEqual(created.returncode, 0, created.stderr)
        self.assertNotIn("\\", created.stdout)

    def test_list_marks_current_task_with_mixed_path_separators(self):
        current = self._create_task()
        pointer = Path(task.get_current_task_file(str(self.project)))
        relative = current.relative_to(self.project)
        # On Windows this differs from os.path.join(DIR_TASKS, id).
        pointer.write_text(str(relative), encoding="utf-8")
        result = self._task_cli("list")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("* " + current.name + " [in_progress]", result.stdout)
        pointer.write_text(relative.as_posix(), encoding="utf-8")
        self.assertIn("* " + current.name, self._task_cli("list").stdout)

    def test_setup_verify_round_trips_exact_command(self):
        command = 'pnpm typecheck && echo "url:http://example.test/a:b"'
        result = self._setup("--verify", command, "quoted command")
        self.assertEqual(result.returncode, 0, result.stderr)
        frontmatter, _ = self._read_task()
        self.assertEqual(frontmatter.get("verify_command"), command)

    def test_project_default_and_override_and_invalid_json(self):
        command = python_command("from pathlib import Path;Path('default.txt').write_text('yes')")
        (self.project / ".claude" / "do.json").write_text(
            json.dumps({"verify_command": command}), encoding="utf-8"
        )
        result = self._setup("default command")
        self.assertEqual(result.returncode, 0, result.stderr)
        frontmatter, _ = self._read_task()
        self.assertEqual(frontmatter.get("verify_command"), command)
        self._set_task(current_phase=5, max_phases=5, phase_name="Complete")
        self._stop_json()
        self.assertTrue((self.project / "default.txt").exists())

        override = 'echo "override"'
        result = self._setup("--verify", override, "override command")
        self.assertEqual(result.returncode, 0, result.stderr)
        frontmatter, _ = self._read_task()
        self.assertEqual(frontmatter.get("verify_command"), override)

        (self.project / ".claude" / "do.json").write_text("{invalid", encoding="utf-8")
        result = self._setup("invalid config")
        self.assertEqual(result.returncode, 0, result.stderr)
        frontmatter, _ = self._read_task()
        self.assertEqual(frontmatter.get("verify_command"), "")
        self._set_task(current_phase=5, max_phases=5, phase_name="Complete")
        self._stop_json()
        frontmatter, _ = self._read_task()
        self.assertEqual(frontmatter.get("status"), "completed")

    def test_setup_persists_max_phases_and_completion_promise(self):
        promise = "<promise>CUSTOM_DONE</promise>"
        result = self._setup("--max-phases", "3", "--completion-promise", promise, "custom task")
        self.assertEqual(result.returncode, 0, result.stderr)
        frontmatter, _ = self._read_task()
        self.assertEqual(frontmatter.get("max_phases"), 3)
        self.assertEqual(frontmatter.get("completion_promise"), promise)

    def test_finish_then_stop_allows(self):
        self._create_task()
        result = self._task_cli("finish")
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self._stop()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_start_task_resets_session_id(self):
        first = self._create_task("first")
        self._set_task(current_phase=2, max_phases=5, session_id=self.session_id)
        self._create_task("second")
        relative_path = os.path.relpath(first, self.project).replace("\\", "/")
        result = self._task_cli("start", relative_path)
        self.assertEqual(result.returncode, 0, result.stderr)
        frontmatter, _ = self._read_task(first)
        self.assertEqual(frontmatter.get("session_id"), "")
        self.assertEqual(Path(task.get_current_task(str(self.project))), Path(relative_path))

    def test_malformed_stdin_fails_open_even_with_active_unbound_task(self):
        self._create_task()
        result = subprocess.run(
            [sys.executable, str(HOOK)],
            cwd=self.project,
            env=self.environment,
            input="{not json",
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=8,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_legacy_frontmatter_keeps_title_bool_and_int(self):
        task_dir = self._create_task()
        content = '---\ntitle: "a: b"\nenabled: true\ncount: 3\nlegacy: "bad\\q"\n---\n\n# Requirements\n'
        (task_dir / "task.md").write_text(content, encoding="utf-8")
        parsed = task.read_task_md(str(task_dir / "task.md"))
        self.assertEqual(parsed["frontmatter"]["title"], "a: b")
        self.assertIs(parsed["frontmatter"]["enabled"], True)
        self.assertEqual(parsed["frontmatter"]["count"], 3)
        self.assertEqual(parsed["frontmatter"]["legacy"], 'bad\\q')

    def test_cyrillic_verify_output_is_valid_ascii_json(self):
        code = "import sys;sys.stdout.buffer.write('Привет мир\\n'.encode('utf-8'));sys.exit(7)"
        self._create_task()
        self._set_task(
            current_phase=5,
            max_phases=5,
            phase_name="Complete",
            verify_command=python_command(code),
        )
        result, output = self._stop_json(environment={"PYTHONIOENCODING": "cp1251"})
        self.assertEqual(output.get("decision"), "block")
        self.assertIn("Привет мир", output.get("reason", ""))
        self.assertTrue(all(ord(character) < 128 for character in result.stdout))


if __name__ == "__main__":
    unittest.main()
