import base64
import json
import os
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
HOOK = ROOT / "hooks" / "stop-hook.py"
SETUP = ROOT / "scripts" / "setup-do.py"
sys.path.insert(0, str(SCRIPTS))
import task


def python_command(code):
    encoded = base64.b64encode(code.encode("utf-8")).decode("ascii")
    command = f"import base64;exec(base64.b64decode('{encoded}'))"
    executable = f'"{sys.executable}"' if os.name == "nt" else shlex.quote(sys.executable)
    quoted_code = f'"{command}"' if os.name == "nt" else shlex.quote(command)
    return f"{executable} -c {quoted_code}"


class DoHookTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.project = Path(self.temp_dir.name)
        (self.project / ".claude").mkdir()
        project_patcher = patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": str(self.project)})
        project_patcher.start()
        self.addCleanup(project_patcher.stop)
        self.environment = os.environ.copy()
        self.environment["CLAUDE_PROJECT_DIR"] = str(self.project)
        self.session_id = "session-a"

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
        frontmatter, body = self._read_task()
        frontmatter.update(values)
        self._write_task(frontmatter, body)

    def _stop(self, payload=None, environment=None):
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
            timeout=8,
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
        state_path = self.project / ".claude" / "do-tasks" / ".stop-state.json"
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
        state_path = self.project / ".claude" / "do-tasks" / ".stop-state.json"
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
