#!/usr/bin/env python3
"""Gate the main Stop event on task phases and optional verification."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

MAX_BLOCKS = 5

try:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
    from task import DIR_TASKS, PHASE_NAMES, STATE_FILE, load_task, registered_task, save_task
except Exception as error:
    IMPORT_ERROR = error
else:
    IMPORT_ERROR = None


def read_payload() -> dict:
    """Treat malformed, empty, and nonobject hook input as unusable."""
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8", errors="replace"))
    except (ValueError, OSError):
        return {}
    return payload if isinstance(payload, dict) else {}


def nonempty_string(value) -> str:
    """Accept only nonempty string identifiers and paths."""
    return value if isinstance(value, str) and value.strip() else ""


def emit(payload: dict) -> None:
    """Keep hook output compatible with Windows legacy pipe encodings."""
    print(json.dumps(payload, ensure_ascii=True))


def load_state(state_path: str, task_dir: str, phase: int) -> dict:
    """Reset missing, invalid, or mismatched task and phase counters."""
    default = {"task": task_dir, "phase": phase, "blocks": 0}
    try:
        with open(state_path, "r", encoding="utf-8") as state_file:
            state = json.load(state_file)
    except (OSError, ValueError):
        return default
    if (
        not isinstance(state, dict)
        or state.get("task") != task_dir
        or type(state.get("phase")) is not int
        or state.get("phase") != phase
    ):
        return default
    blocks = state.get("blocks")
    if type(blocks) is not int or blocks < 0:
        return default
    return {"task": task_dir, "phase": phase, "blocks": blocks}


def save_state(state_path: str, state: dict) -> None:
    """Persist the Stop counter, raising on storage errors."""
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    with open(state_path, "w", encoding="utf-8") as state_file:
        json.dump(state, state_file, ensure_ascii=True)


def block_incomplete(frontmatter: dict, state_path: str, state: dict) -> None:
    """Remind the main agent to complete phases, with a bounded block count."""
    if state["blocks"] >= MAX_BLOCKS:
        emit({"systemMessage": "do loop incomplete after 5 Stop blocks; allowing exit to prevent an infinite loop."})
        return
    state["blocks"] += 1
    save_state(state_path, state)
    phase = int(frontmatter.get("current_phase", 1))
    maximum = int(frontmatter.get("max_phases", 5))
    name = frontmatter.get("phase_name", PHASE_NAMES.get(phase, f"Phase {phase}"))
    promise = frontmatter.get("completion_promise", "<promise>DO_COMPLETE</promise>")
    script_path = (Path(__file__).resolve().parent.parent / "scripts" / "task.py").as_posix()
    reason = (
        f"do loop incomplete: current phase {phase}/{maximum} ({name}). "
        "Continue with remaining phases; use task.py update-phase <N> after each phase. "
        f"Print the configured completion_promise when done: {promise}. "
        f"to abandon: python3 {script_path} finish"
    )
    emit({"decision": "block", "reason": reason})


def _verify_timeout() -> int:
    """Leave a margin before the Stop hook's own 1800-second timeout."""
    value = os.environ.get("DO_VERIFY_TIMEOUT")
    if value is None:
        return 1500
    try:
        timeout = int(value)
    except ValueError:
        timeout = 0
    if timeout <= 0:
        print("Warning: Invalid DO_VERIFY_TIMEOUT; using 1500 seconds.", file=sys.stderr)
        return 1500
    return min(timeout, 1740)


def _kill_tree(proc) -> None:
    """Terminate descendants before falling back to killing the shell."""
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired):
            pass
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
    try:
        proc.kill()
    except OSError:
        pass


def _wait_for_verification(proc, timeout: int) -> bool:
    """Return whether verification timed out, with a bounded cleanup wait."""
    try:
        proc.wait(timeout=timeout)
        return False
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    return True


def run_verification(command: str, directory: str) -> tuple[int | str, str]:
    """Run the configured shell command and preserve useful timeout output."""
    timeout = _verify_timeout()
    with tempfile.TemporaryFile() as tmp:
        proc = subprocess.Popen(
            command,
            shell=True,
            cwd=directory,
            stdout=tmp,
            stderr=subprocess.STDOUT,
            **({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
               if os.name == "nt" else {"start_new_session": True}),
        )
        timed_out = _wait_for_verification(proc, timeout)
        tmp.seek(0)
        output = tmp.read().decode("utf-8", errors="replace")
    if timed_out:
        return "timeout", f"{output}\nVerification timed out after {timeout} seconds."
    return proc.returncode, output


def verify_task(loaded: tuple, project_dir: str, state_path: str, state: dict, command: str) -> None:
    """Complete successful tasks or bound the verification repair loop."""
    task_md_path, frontmatter, body = loaded
    command = nonempty_string(command)
    if not command:
        frontmatter["status"] = "completed"
        save_task(task_md_path, frontmatter, body)
        return
    worktree_dir = nonempty_string(frontmatter.get("worktree_dir"))
    directory = worktree_dir if os.path.isdir(worktree_dir) else project_dir
    if directory == worktree_dir:
        try:
            result = subprocess.run(
                ["git", "-C", project_dir, "rev-parse", "--show-toplevel"],
                capture_output=True, text=True, check=True,
            )
            relative = Path(project_dir).resolve().relative_to(Path(result.stdout.strip()).resolve())
            subdirectory = Path(worktree_dir) / relative
            if subdirectory.is_dir():
                directory = str(subdirectory)
        except (subprocess.CalledProcessError, OSError, ValueError):
            pass
    exit_code, output = run_verification(command, directory)
    if exit_code == 0:
        frontmatter["status"] = "completed"
        save_task(task_md_path, frontmatter, body)
        state["blocks"] = 0
        save_state(state_path, state)
        return
    state["blocks"] += 1
    save_state(state_path, state)
    if state["blocks"] >= MAX_BLOCKS:
        frontmatter["status"] = "verify_failed"
        save_task(task_md_path, frontmatter, body)
        emit({"systemMessage": f"verification still failing after 5 attempts: {command}"})
        return
    reason = (
        f"Verification failed (attempt {state['blocks']}/{MAX_BLOCKS}): `{command}` exit {exit_code}\n"
        f"{output[-3000:]}\nFix via the develop agent, then finish again."
    )
    emit({"decision": "block", "reason": reason})


def main() -> None:
    if IMPORT_ERROR is not None:
        raise IMPORT_ERROR
    payload = read_payload()
    if not payload:
        return
    project_dir = (
        nonempty_string(os.environ.get("CLAUDE_PROJECT_DIR"))
        or nonempty_string(payload.get("cwd"))
        or os.getcwd()
    )
    loaded = load_task(project_dir)
    if not loaded:
        return
    task_md_path, frontmatter, body = loaded
    registration = registered_task(project_dir, task_md_path)
    if registration is None:
        return
    if frontmatter.get("status") in ("completed", "verify_failed", "cancelled"):
        return
    session_id = nonempty_string(payload.get("session_id"))
    task_session_id = nonempty_string(frontmatter.get("session_id"))
    if task_session_id and task_session_id != session_id:
        return
    if not task_session_id and session_id:
        frontmatter["session_id"] = session_id
        save_task(task_md_path, frontmatter, body)
    task_dir = os.path.relpath(os.path.dirname(task_md_path), project_dir)
    state_path = os.path.join(project_dir, DIR_TASKS, STATE_FILE)
    current_phase = frontmatter.get("current_phase", 1)
    state = load_state(state_path, task_dir, int(current_phase))
    if int(current_phase) < int(frontmatter.get("max_phases", 5)):
        block_incomplete(frontmatter, state_path, state)
        return
    verify_task(loaded, project_dir, state_path, state, registration["verify_command"])


def report_error(error: Exception) -> None:
    """Report unexpected errors safely without blocking the Stop event."""
    try:
        message = f"do Stop hook failed open: {error}"
        sys.stderr.write(message.encode("ascii", errors="backslashreplace").decode("ascii") + "\n")
    except Exception:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        report_error(error)
