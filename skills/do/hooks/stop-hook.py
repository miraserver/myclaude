#!/usr/bin/env python3
"""Gate the main Stop event on task phases and optional verification."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

MAX_BLOCKS = 5
STATE_FILE = ".stop-state.json"

try:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
    from task import DIR_TASKS, PHASE_NAMES, load_task, save_task
except Exception as error:
    IMPORT_ERROR = error
else:
    IMPORT_ERROR = None


def read_payload() -> dict:
    """Treat malformed, empty, and nonobject hook input as unusable."""
    try:
        payload = json.load(sys.stdin)
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


def normalize_output(output) -> str:
    """Decode timeout output, which can be bytes even in text mode."""
    if isinstance(output, bytes):
        return output.decode("utf-8", errors="replace")
    return output if isinstance(output, str) else ""


def run_verification(command: str, directory: str) -> tuple[int | str, str]:
    """Run the configured shell command and preserve useful timeout output."""
    timeout = int(os.environ.get("DO_VERIFY_TIMEOUT") or 1500)
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=directory,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        output = normalize_output(error.stdout)
        return "timeout", f"{output}\nVerification timed out after {timeout} seconds."
    return result.returncode, normalize_output(result.stdout)


def verify_task(loaded: tuple, project_dir: str, state_path: str, state: dict) -> None:
    """Complete successful tasks or bound the verification repair loop."""
    task_md_path, frontmatter, body = loaded
    command = nonempty_string(frontmatter.get("verify_command"))
    if not command:
        frontmatter["status"] = "completed"
        save_task(task_md_path, frontmatter, body)
        return
    worktree_dir = nonempty_string(frontmatter.get("worktree_dir"))
    directory = worktree_dir if os.path.isdir(worktree_dir) else project_dir
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
    if frontmatter.get("status") in ("completed", "verify_failed"):
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
    verify_task(loaded, project_dir, state_path, state)


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
