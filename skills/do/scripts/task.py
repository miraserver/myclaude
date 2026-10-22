#!/usr/bin/env python3
"""
Task Directory Management CLI for do skill workflow.

Commands:
  create <title>              - Create a new task directory with task.md
  start <task-dir>            - Set current task pointer
  finish                      - Clear current task pointer
  list                        - List active tasks
  status                      - Show current task status
  update-phase <N>            - Update current phase
  set-verify <command>        - Update current verification command
  worktree                    - Attach a worktree to the current task
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import string
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from contextlib import contextmanager
from pathlib import Path

# Directory constants
DIR_TASKS = ".claude/do-tasks"
FILE_CURRENT_TASK = ".current-task"
FILE_TASK_MD = "task.md"
STATE_FILE = ".stop-state.json"

PHASE_NAMES = {
    1: "Understand",
    2: "Clarify",
    3: "Design",
    4: "Implement",
    5: "Complete",
}


def registry_path() -> Path:
    return Path.home() / ".claude" / "do-state" / "registry.json"


@contextmanager
def _registry_lock():
    """Hold an OS lock for the entire registry transaction.

    Keep the lock file: unlinking it could split waiters across two inodes.
    The OS releases the lock automatically if the process exits.
    """
    path = registry_path().with_name("registry.lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        if os.name == "nt":
            import msvcrt
            def acquire():
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            def release():
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            def acquire():
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            def release():
                fcntl.flock(fd, fcntl.LOCK_UN)
        deadline = time.monotonic() + 5.0
        while True:
            try:
                acquire()
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Timed out waiting for registry lock: " + str(path))
                time.sleep(0.02)
        try:
            yield
        finally:
            release()
    finally:
        os.close(fd)


def _registry_retry(operation, timeout):
    """Retry Windows sharing violations, leaving other failures unchanged."""
    deadline = time.monotonic() + timeout
    while True:
        try:
            return operation()
        except PermissionError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.02)


def load_registry(*, strict=False) -> dict:
    """Fail closed for readers; strict writers preserve unreadable files."""
    try:
        registry = json.loads(_registry_retry(
            lambda: registry_path().read_text(encoding="utf-8"), 1.0))
        if not isinstance(registry, dict):
            raise ValueError("expected an object")
        for tasks in registry.values():
            if not isinstance(tasks, dict):
                raise ValueError("expected task objects")
            for entry in tasks.values():
                if (not isinstance(entry, dict)
                        or not isinstance(entry.get("verify_command"), str)
                        or not isinstance(entry.get("created_at"), str)):
                    raise ValueError("invalid task entry")
        return registry
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        if strict:
            raise
        print(f"Warning: Cannot read do registry; treating as empty: {error}", file=sys.stderr)
        return {}


def registered_task(project_root: str, task_md_path: str) -> dict | None:
    """Only authorize a direct task directory in this resolved project."""
    project = Path(project_root).resolve()
    directory = Path(task_md_path).resolve().parent
    if directory.parent != (project / DIR_TASKS).resolve():
        return None
    return load_registry().get(str(project), {}).get(directory.name)


def register_task(project_root: str, task_md_path: str, command: str, created_at: str) -> None:
    """Atomically persist commands authorized through task creation/set-verify."""
    with _registry_lock():
        registry = load_registry(strict=True)
        project = str(Path(project_root).resolve())
        name = Path(task_md_path).resolve().parent.name
        tasks = registry.setdefault(project, {})
        previous = tasks.get(name, {})
        tasks[name] = {
            "verify_command": command,
            "created_at": previous.get("created_at", created_at),
        }
        path = registry_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                             prefix="registry-", suffix=".tmp", delete=False) as output:
                temporary = Path(output.name)
                json.dump(registry, output, ensure_ascii=True)
            _registry_retry(lambda: os.replace(temporary, path), 2.0)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


def get_project_root() -> str:
    """Get project root from env or cwd."""
    return os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()


def get_tasks_dir(project_root: str) -> str:
    """Get tasks directory path."""
    return os.path.join(project_root, DIR_TASKS)


def get_current_task_file(project_root: str) -> str:
    """Get current task pointer file path."""
    return os.path.join(project_root, DIR_TASKS, FILE_CURRENT_TASK)


def generate_task_id() -> str:
    """Generate short task ID: MMDD-XXXX format."""
    date_part = datetime.now().strftime("%m%d")
    random_part = ''.join(random.choices(string.ascii_lowercase + string.digits, k=4))
    return f"{date_part}-{random_part}"


def parse_frontmatter_value(value: str):
    """Parse JSON-quoted strings and legacy frontmatter scalars."""
    if value.startswith('"'):
        try:
            return json.loads(value)
        except ValueError:
            return value[1:-1] if value.endswith('"') else value[1:]
    if value in ("true", "false"):
        return value == "true"
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    return value


def read_task_md(task_md_path: str) -> dict | None:
    """Read task.md and parse YAML frontmatter + body."""
    if not os.path.exists(task_md_path):
        return None

    try:
        with open(task_md_path, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return None

    # Parse YAML frontmatter
    match = re.match(r'^---\n(.*?)\n---\n(.*)$', content, re.DOTALL)
    if not match:
        return None

    frontmatter_str = match.group(1)
    body = match.group(2)

    frontmatter = {}
    for line in frontmatter_str.split('\n'):
        if ':' not in line:
            continue
        key, value = line.split(':', 1)
        frontmatter[key.strip()] = parse_frontmatter_value(value.strip())

    return {"frontmatter": frontmatter, "body": body}


def format_frontmatter_value(value) -> str:
    """Serialize frontmatter strings without losing shell command quoting."""
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return str(value).lower()
    return str(value)


def save_task(task_md_path: str, frontmatter: dict, body: str) -> None:
    """Save task metadata and the unchanged Markdown body, raising on failure."""
    lines = ["---"]
    lines.extend(f"{key}: {format_frontmatter_value(value)}" for key, value in frontmatter.items())
    lines.append("---")
    with open(task_md_path, "w", encoding="utf-8") as task_file:
        task_file.write("\n".join(lines) + "\n" + body)


def write_task_md(task_md_path: str, frontmatter: dict, body: str) -> bool:
    """Write task.md, retaining the legacy boolean success API."""
    try:
        save_task(task_md_path, frontmatter, body)
        return True
    except Exception:
        return False


def create_worktree(project_root: str, task_id: str, worktree_dir: str = "") -> str:
    """Create a git worktree for the task. Returns the worktree directory path."""
    # Get git root
    result = subprocess.run(
        ["git", "-C", project_root, "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Not a git repository: {project_root}")
    git_root = result.stdout.strip()

    # Calculate paths
    worktree_dir = worktree_dir or os.path.join(git_root, ".worktrees", f"do-{task_id}")
    branch_name = f"do/{task_id}"

    branch = subprocess.run(
        ["git", "-C", git_root, "show-ref", "--verify", "--quiet", f"refs/heads/{branch_name}"],
        capture_output=True, text=True,
    )
    if branch.returncode == 0:
        pruned = subprocess.run(
            ["git", "-C", git_root, "worktree", "prune"],
            capture_output=True, text=True,
        )
        if pruned.returncode != 0:
            raise RuntimeError(f"Failed to prune worktrees: {pruned.stderr}")
        arguments = [worktree_dir, branch_name]
    else:
        arguments = ["-b", branch_name, worktree_dir]

    result = subprocess.run(
        ["git", "-C", git_root, "worktree", "add", *arguments],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to create worktree: {result.stderr}")

    return Path(worktree_dir).as_posix()


def resolve_verify_command(project_root: str, verify_command: str | None) -> str:
    """Resolve an explicit command before the optional project configuration."""
    if isinstance(verify_command, str) and verify_command.strip():
        return verify_command
    config_path = os.path.join(project_root, ".claude", "do.json")
    try:
        with open(config_path, "r", encoding="utf-8") as config_file:
            config = json.load(config_file)
    except (OSError, ValueError):
        return ""
    if not isinstance(config, dict):
        return ""
    command = config.get("verify_command", "")
    return command if isinstance(command, str) else ""


def create_task(
    title: str,
    use_worktree: bool = False,
    verify_command: str | None = None,
    max_phases: int = 5,
    completion_promise: str = "<promise>DO_COMPLETE</promise>",
) -> dict:
    """Create a new task directory with task.md."""
    project_root = get_project_root()
    tasks_dir = get_tasks_dir(project_root)
    os.makedirs(tasks_dir, exist_ok=True)

    task_id = generate_task_id()
    task_dir = os.path.join(tasks_dir, task_id)

    os.makedirs(task_dir, exist_ok=True)

    # Create worktree if requested
    worktree_dir = ""
    if use_worktree:
        try:
            worktree_dir = create_worktree(project_root, task_id)
        except RuntimeError as e:
            print(f"Warning: {e}", file=sys.stderr)
            use_worktree = False

    frontmatter = {
        "id": task_id,
        "title": title,
        "status": "in_progress",
        "current_phase": 1,
        "phase_name": PHASE_NAMES[1],
        "max_phases": max_phases,
        "use_worktree": use_worktree,
        "worktree_dir": worktree_dir,
        "created_at": datetime.now().isoformat(),
        "completion_promise": completion_promise,
        "verify_command": resolve_verify_command(project_root, verify_command),
        "session_id": "",
    }

    body = f"""
# Requirements

{title}

## Context

## Progress
"""

    task_md_path = os.path.join(task_dir, FILE_TASK_MD)
    save_task(task_md_path, frontmatter, body)

    register_task(project_root, task_md_path, frontmatter["verify_command"], frontmatter["created_at"])

    current_task_file = get_current_task_file(project_root)
    relative_task_dir = os.path.relpath(task_dir, project_root)
    with open(current_task_file, "w", encoding="utf-8") as f:
        f.write(relative_task_dir)

    return {
        "task_dir": task_dir,
        "relative_path": relative_task_dir,
        "task_data": frontmatter,
        "worktree_dir": worktree_dir,
    }


def get_current_task(project_root: str) -> str | None:
    """Read current task directory path."""
    current_task_file = get_current_task_file(project_root)
    if not os.path.exists(current_task_file):
        return None

    try:
        with open(current_task_file, "r", encoding="utf-8") as f:
            content = f.read().strip()
            return content if content else None
    except Exception:
        return None


def load_task(project_root: str) -> tuple[str, dict, str] | None:
    """Load the current task's path, frontmatter, and Markdown body."""
    current_task = get_current_task(project_root)
    if not current_task:
        return None
    task_md_path = os.path.join(project_root, current_task, FILE_TASK_MD)
    parsed = read_task_md(task_md_path)
    if not parsed:
        return None
    return task_md_path, parsed["frontmatter"], parsed["body"]


def attach_worktree() -> bool:
    """Attach a worktree without replacing the current task or its state."""
    project_root = get_project_root()
    loaded = load_task(project_root)
    if not loaded:
        print("Error: No active task or unreadable task.md.", file=sys.stderr)
        return False
    task_md_path, frontmatter, body = loaded
    task_id = frontmatter.get("id")
    if not isinstance(task_id, str) or not task_id.strip():
        print("Error: task.md frontmatter must contain a non-empty id.", file=sys.stderr)
        return False
    worktree_dir = frontmatter.get("worktree_dir", "")
    if worktree_dir and Path(worktree_dir).is_dir():
        print(f"export DO_WORKTREE_DIR={Path(worktree_dir).as_posix()}")
        return True
    try:
        worktree_dir = create_worktree(project_root, task_id, worktree_dir)
    except (OSError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return False
    frontmatter["use_worktree"] = True
    frontmatter["worktree_dir"] = worktree_dir
    if not write_task_md(task_md_path, frontmatter, body):
        print("Error: Failed to write task.md.", file=sys.stderr)
        return False
    print(f"export DO_WORKTREE_DIR={Path(worktree_dir).as_posix()}")
    return True


def resolve_task_dir(project_root: str, task_dir: str) -> str:
    """Accept task IDs, project-relative paths, and absolute task paths."""
    task_dir = os.path.normpath(task_dir)
    if os.path.isabs(task_dir):
        return task_dir
    tasks_prefix = os.path.normpath(DIR_TASKS) + os.sep
    if task_dir.startswith(tasks_prefix):
        return os.path.join(project_root, task_dir)
    return os.path.join(get_tasks_dir(project_root), task_dir)


def start_task(task_dir: str) -> bool:
    """Set current task pointer."""
    project_root = get_project_root()
    full_path = resolve_task_dir(project_root, task_dir)
    relative_path = os.path.relpath(full_path, project_root)

    if not os.path.exists(full_path):
        print(f"Error: Task directory not found: {full_path}", file=sys.stderr)
        return False

    task_md_path = os.path.join(full_path, FILE_TASK_MD)
    parsed = read_task_md(task_md_path)
    if not parsed:
        print("Error: task.md not found or invalid.", file=sys.stderr)
        return False
    parsed["frontmatter"]["session_id"] = ""
    if not write_task_md(task_md_path, parsed["frontmatter"], parsed["body"]):
        print("Error: Failed to write task.md.", file=sys.stderr)
        return False

    current_task_file = get_current_task_file(project_root)
    os.makedirs(os.path.dirname(current_task_file), exist_ok=True)

    with open(current_task_file, "w", encoding="utf-8") as f:
        f.write(relative_path)

    return True


def finish_task() -> bool:
    """Clear current task pointer."""
    project_root = get_project_root()
    current_task_file = get_current_task_file(project_root)

    if os.path.exists(current_task_file):
        os.remove(current_task_file)

    return True


def list_tasks() -> list[dict]:
    """List all task directories."""
    project_root = get_project_root()
    tasks_dir = get_tasks_dir(project_root)

    if not os.path.exists(tasks_dir):
        return []

    tasks = []
    current_task = get_current_task(project_root)

    for entry in sorted(os.listdir(tasks_dir), reverse=True):
        entry_path = os.path.join(tasks_dir, entry)
        if not os.path.isdir(entry_path):
            continue

        task_md_path = os.path.join(entry_path, FILE_TASK_MD)
        if not os.path.exists(task_md_path):
            continue

        parsed = read_task_md(task_md_path)
        if parsed:
            task_data = parsed["frontmatter"]
        else:
            task_data = {"id": entry, "title": entry, "status": "unknown"}

        relative_path = os.path.join(DIR_TASKS, entry)
        task_data["path"] = relative_path
        task_data["is_current"] = bool(current_task) and (
            os.path.normcase(os.path.normpath(current_task))
            == os.path.normcase(os.path.normpath(relative_path))
        )
        tasks.append(task_data)

    return tasks


def get_status() -> dict | None:
    """Get current task status."""
    project_root = get_project_root()
    current_task = get_current_task(project_root)

    if not current_task:
        return None

    task_dir = os.path.join(project_root, current_task)
    task_md_path = os.path.join(task_dir, FILE_TASK_MD)

    parsed = read_task_md(task_md_path)
    if not parsed:
        return None

    task_data = parsed["frontmatter"]
    task_data["path"] = current_task
    return task_data


def update_phase(phase: int) -> bool:
    """Update current task phase."""
    project_root = get_project_root()
    current_task = get_current_task(project_root)

    if not current_task:
        print("Error: No active task.", file=sys.stderr)
        return False

    task_dir = os.path.join(project_root, current_task)
    task_md_path = os.path.join(task_dir, FILE_TASK_MD)

    parsed = read_task_md(task_md_path)
    if not parsed:
        print("Error: task.md not found or invalid.", file=sys.stderr)
        return False

    frontmatter = parsed["frontmatter"]
    frontmatter["current_phase"] = phase
    frontmatter["phase_name"] = PHASE_NAMES.get(phase, f"Phase {phase}")

    if not write_task_md(task_md_path, frontmatter, parsed["body"]):
        print("Error: Failed to write task.md.", file=sys.stderr)
        return False

    return True


def set_verify(command: str) -> bool:
    """Set or explicitly clear the current task's verification command."""
    project_root = get_project_root()
    loaded = load_task(project_root)
    if not loaded:
        print("Error: No active task or unreadable task.md.", file=sys.stderr)
        return False
    task_md_path, frontmatter, body = loaded
    frontmatter["verify_command"] = command
    if frontmatter.get("status") == "verify_failed":
        # A missing state file gives the next Stop a fresh verification budget.
        try:
            Path(project_root, DIR_TASKS, STATE_FILE).unlink(missing_ok=True)
        except OSError as error:
            print(f"Error: Failed to reset Stop state: {error}", file=sys.stderr)
            return False
        frontmatter["status"] = "in_progress"
    if not write_task_md(task_md_path, frontmatter, body):
        print("Error: Failed to write task.md.", file=sys.stderr)
        return False
    try:
        register_task(project_root, task_md_path, command, datetime.now().isoformat())
    except OSError as error:
        print(f"Error: Failed to write do registry: {error}", file=sys.stderr)
        return False
    return True


def print_tasks(tasks: list[dict]) -> None:
    """Print tasks in their supplied order using the existing CLI format."""
    if not tasks:
        print("No tasks found.")
        return
    for task in tasks:
        marker = "* " if task.get("is_current") else "  "
        phase = task.get("current_phase", "?")
        max_phase = task.get("max_phases", 5)
        status = task.get("status", "unknown")
        print(f"{marker}{task['id']} [{status}] phase {phase}/{max_phase}")
        print(f"    {task.get('title', 'No title')}")


def main():
    parser = argparse.ArgumentParser(
        description="Task directory management for do skill workflow"
    )
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # create command
    create_parser = subparsers.add_parser("create", help="Create a new task")
    create_parser.add_argument("title", nargs="+", help="Task title")
    create_parser.add_argument("--worktree", action="store_true", help="Enable worktree mode")

    # start command
    start_parser = subparsers.add_parser("start", help="Set current task")
    start_parser.add_argument("task_dir", help="Task directory path")

    # finish command
    subparsers.add_parser("finish", help="Clear current task")

    # list command
    subparsers.add_parser("list", help="List all tasks")

    # status command
    subparsers.add_parser("status", help="Show current task status")
    subparsers.add_parser("worktree", help="Attach a worktree to the current task")

    # update-phase command
    phase_parser = subparsers.add_parser("update-phase", help="Update current phase")
    phase_parser.add_argument("phase", type=int, help="Phase number (1-5)")

    verify_parser = subparsers.add_parser("set-verify", help="Set verification command")
    verify_parser.add_argument("verify_command", help="Shell command; empty string clears verification")

    args = parser.parse_args()

    if args.command == "create":
        title = " ".join(args.title)
        result = create_task(title, args.worktree)
        print(f"Created task: {Path(result['relative_path']).as_posix()}")
        print(f"Task ID: {result['task_data']['id']}")
        print(f"Phase: 1/{result['task_data']['max_phases']} (Understand)")
        print(f"Worktree: {result['task_data']['use_worktree']}")

    elif args.command == "start":
        if start_task(args.task_dir):
            print(f"Started task: {Path(args.task_dir).as_posix()}")
        else:
            sys.exit(1)

    elif args.command == "finish":
        if finish_task():
            print("Task finished, current task cleared.")
        else:
            sys.exit(1)

    elif args.command == "list":
        print_tasks(list_tasks())

    elif args.command == "status":
        status = get_status()
        if not status:
            print("No active task.")
        else:
            print(f"Task: {status['id']}")
            print(f"Title: {status.get('title', 'No title')}")
            print(f"Status: {status.get('status', 'unknown')}")
            print(f"Phase: {status.get('current_phase', '?')}/{status.get('max_phases', 5)}")
            print(f"Worktree: {status.get('use_worktree', False)}")
            print(f"Path: {Path(status['path']).as_posix()}")

    elif args.command == "worktree":
        if not attach_worktree():
            sys.exit(1)

    elif args.command == "update-phase":
        if update_phase(args.phase):
            phase_name = PHASE_NAMES.get(args.phase, f"Phase {args.phase}")
            print(f"Updated to phase {args.phase} ({phase_name})")
        else:
            sys.exit(1)

    elif args.command == "set-verify":
        if not set_verify(args.verify_command):
            sys.exit(1)
        print(f"Verification command: {args.verify_command or '(none)'}")

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
