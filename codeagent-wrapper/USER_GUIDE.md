# Codeagent-Wrapper User Guide

Multi-backend AI code execution wrapper supporting Codex, Claude, Gemini, and OpenCode.

## Overview

`codeagent-wrapper` is a Go-based CLI tool that provides a unified interface to multiple AI coding backends. It handles:
- Multi-backend execution (Codex, Claude, Gemini, OpenCode)
- JSON stream parsing and output formatting
- Session management and resumption
- Parallel task execution with dependency resolution
- Async execution with per-task completion summaries and signal forwarding

## Installation

```bash
# Recommended: run the installer and select "codeagent-wrapper"
npx github:miraserver/myclaude

# Manual build (optional; requires repo checkout)
cd codeagent-wrapper
go build -o ~/.claude/bin/codeagent-wrapper ./cmd/codeagent-wrapper
```

## Quick Start

### Basic Usage

```bash
# Simple task (default: codex backend)
codeagent-wrapper "explain @src/main.go"

# With backend selection
codeagent-wrapper --backend claude "refactor @utils.ts"

# With HEREDOC (recommended for complex tasks)
codeagent-wrapper --backend gemini - <<'EOF'
Implement user authentication:
- JWT tokens
- Password hashing with bcrypt
- Session management
EOF
```

### CLI Flags

| Flag | Description |
|------|-------------|
| `--backend <name>` | Select backend (codex/claude/gemini/opencode) |
| `--model <name>` | Override model for this invocation |
| `--agent <name>` | Agent preset name (from ~/.codeagent/models.json) |
| `--config <path>` | Viper config file path (default: `~/.codeagent/config.*`); agent presets always use `~/.codeagent/models.json` |
| `--cleanup` | Clean up historical log files and exit |
| `--worktree` | Execute in a new git worktree (auto-generates task ID) |
| `--skills <names>` | Comma-separated skill names for spec injection |
| `--prompt-file <path>` | Read prompt from file |
| `--reasoning-effort <level>` | Set reasoning effort (low/medium/high) |
| `--skip-permissions` | Claude: skip permission prompts (effective default: true; use `=false` to restore prompts) |
| `--parallel` | Enable parallel task execution |
| `--full-output` | Show full output in parallel mode |
| `--version`, `-v` | Print version and exit |

### Backend Selection

| Backend | Command | Best For |
|---------|---------|----------|
| **Codex** | `--backend codex` | General code tasks (default) |
| **Claude** | `--backend claude` | Complex reasoning, architecture |
| **Gemini** | `--backend gemini` | Fast iteration, prototyping |
| **OpenCode** | `--backend opencode` | Open-source alternative |

## Core Features

### 1. Multi-Backend Support

```bash
# Codex (default)
codeagent-wrapper "add logging to @app.js"

# Claude for architecture decisions
codeagent-wrapper --backend claude - <<'EOF'
Design a microservices architecture for e-commerce:
- Service boundaries
- Communication patterns
- Data consistency strategy
EOF

# Gemini for quick prototypes
codeagent-wrapper --backend gemini "create React component for user profile"
```

### 2. File References with @ Syntax

```bash
# Single file
codeagent-wrapper "optimize @src/utils.ts"

# Multiple files
codeagent-wrapper "refactor @src/auth.ts and @src/middleware.ts"

# Entire directory
codeagent-wrapper "analyze @src for security issues"
```

### 3. Session Management

```bash
# First task
codeagent-wrapper "add validation to user form"
# Output includes: SESSION_ID: 019a7247-ac9d-71f3-89e2-a823dbd8fd14

# Resume session
codeagent-wrapper resume 019a7247-ac9d-71f3-89e2-a823dbd8fd14 - <<'EOF'
Now add error messages for each validation rule
EOF
```

### 4. Parallel Execution

Execute multiple tasks concurrently with dependency management:

```bash
# Default: summary output (context-efficient, recommended)
codeagent-wrapper --parallel <<'EOF'
---TASK---
id: backend_1701234567
workdir: /project/backend
---CONTENT---
implement /api/users endpoints with CRUD operations

---TASK---
id: frontend_1701234568
workdir: /project/frontend
---CONTENT---
build Users page consuming /api/users

---TASK---
id: tests_1701234569
workdir: /project/tests
dependencies: backend_1701234567, frontend_1701234568
---CONTENT---
add integration tests for user management flow
EOF

# Full output mode (for debugging, includes complete task messages)
codeagent-wrapper --parallel --full-output <<'EOF'
...
EOF
```

**Output Modes:**
- **Summary (default)**: Structured report with extracted `Did/Files/Tests/Coverage`, plus a short action summary.
- **Full (`--full-output`)**: Complete task messages included. Use only for debugging.

**Summary Output Example:**
```
=== Execution Report ===
3 tasks | 2 passed | 1 failed | 1 below 90%

## Task Results

### backend_api ✓ 92%
Did: Implemented /api/users CRUD endpoints
Files: backend/users.go, backend/router.go
Tests: 12 passed
Log: /tmp/codeagent-xxx.log

### frontend_form ⚠️ 88% (below 90%)
Did: Created login form with validation
Files: frontend/LoginForm.tsx
Tests: 8 passed
Gap: lines not covered: frontend/LoginForm.tsx:42-47
Log: /tmp/codeagent-yyy.log

### integration_tests ✗ FAILED
Exit code: 1
Error: Assertion failed at line 45
Detail: Expected status 200 but got 401
Log: /tmp/codeagent-zzz.log

## Summary
- 2/3 completed successfully
- Fix: integration_tests (Assertion failed at line 45)
- Coverage: frontend_form
```

**Parallel Task Format:**
- `---TASK---` - Starts task block
- `id: <unique_id>` - Required, use `<feature>_<timestamp>` format
- `workdir: <path>` - Optional, defaults to current directory
- `dependencies: <id1>, <id2>` - Optional, comma-separated task IDs
- `---CONTENT---` - Separates metadata from task content

**Features:**
- Automatic topological sorting
- Up to 10 concurrent workers by default; set `CODEAGENT_MAX_PARALLEL_WORKERS=0` for unlimited concurrency (positive values are capped at 100)
- Error isolation (failures don't stop other tasks)
- Dependency blocking (skip if parent fails)

### 5. Working Directory

```bash
# Execute in specific directory
codeagent-wrapper "run tests" /path/to/project

# With backend selection
codeagent-wrapper --backend claude "analyze code" /project/backend

# With HEREDOC
codeagent-wrapper - /path/to/project <<'EOF'
refactor database layer
EOF
```

## Advanced Usage

### Async Execution

`codeagent-wrapper` has no execution timeout. The wrapper waits for backend completion events/process exit, keeps the task log on disk, and reports per-task summaries as work finishes.

### Complex Multi-line Tasks

Use HEREDOC to avoid shell escaping issues:

```bash
codeagent-wrapper - <<'EOF'
Refactor authentication system:

Current issues:
- Password stored as plain text
- No rate limiting on login
- Sessions don't expire

Requirements:
1. Hash passwords with bcrypt
2. Add rate limiting (5 attempts/15min)
3. Session expiry after 24h
4. Add refresh token mechanism

Files to modify:
- @src/auth/login.ts
- @src/middleware/rateLimit.ts
- @config/session.ts
EOF
```

### Backend-Specific Features

**Codex:**
```bash
# Best for code editing and refactoring
codeagent-wrapper --backend codex - <<'EOF'
extract duplicate code in @src into reusable helpers
EOF
```

**Claude:**
```bash
# Best for complex reasoning
codeagent-wrapper --backend claude - <<'EOF'
review @src/payment/processor.ts for:
- Race conditions
- Edge cases
- Security vulnerabilities
EOF
```

**Gemini:**
```bash
# Best for fast iteration
codeagent-wrapper --backend gemini "add TypeScript types to @api.js"
```

## Output Format

Standard output includes parsed agent messages and session ID:

```
Agent response text here...
Implementation details...

---
SESSION_ID: 019a7247-ac9d-71f3-89e2-a823dbd8fd14
```

Error output (stderr):
```
ERROR: Error message details
```

Parallel execution output:
```
=== Parallel Execution Summary ===
Total: 3 | Success: 2 | Failed: 1

--- Task: backend_1701234567 ---
Status: SUCCESS
Session: 019a7247-ac9d-71f3-89e2-a823dbd8fd14

Implementation complete...

--- Task: frontend_1701234568 ---
Status: SUCCESS
Session: 019a7248-ac9d-71f3-89e2-a823dbd8fd14

UI components created...

--- Task: tests_1701234569 ---
Status: FAILED (exit code 1)
Error: dependency backend_1701234567 failed
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error (missing args, no output) |
| 127 | Backend command not found |
| 130 | Interrupted (Ctrl+C) |
| * | Passthrough from backend process |

## Permission and Sandbox Defaults

Claude skips permission prompts and Codex bypasses approvals/sandbox by default so nested agents can run autonomously. To restore Claude prompts, use `--skip-permissions=false` (or `--dangerously-skip-permissions=false`), a parallel task's `skip_permissions: false`, `CODEAGENT_SKIP_PERMISSIONS=false`, or `skip-permissions: false` in the Viper config file. Claude permission priority is explicit CLI flag > explicit per-task field > environment > config file > default (`true`); explicit `false` also overrides preset `yolo`. To disable Codex bypass, set `CODEX_BYPASS_SANDBOX=false`, including with a YOLO preset; there is no Codex bypass config key or CLI flag. Gemini always runs with `-y`; the wrapper has no switch to disable it.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_BYPASS_SANDBOX` | true | Bypass Codex sandbox/approval. Set `false` to disable |
| `CODEAGENT_SKIP_PERMISSIONS` | true | Skip Claude permission prompts. Set `false` to disable |
| `CODEAGENT_MAX_PARALLEL_WORKERS` | 10 | Parallel worker limit (`0` = unlimited, max 100) |

## Troubleshooting

**Backend not found:**
```bash
# Ensure backend CLI is installed
which codex
which claude
which gemini

# Check PATH
echo $PATH
```

**Session ID not found:**
```bash
# List recent sessions (backend-specific)
codex history

# Ensure session ID is copied correctly
codeagent-wrapper resume <session_id> "continue task"
```

**Parallel tasks not running:**
```bash
# Check task format
# Ensure ---TASK--- and ---CONTENT--- delimiters are correct
# Verify task IDs are unique
# Check dependencies reference existing task IDs
```

## Integration with Claude Code

Use via the `codeagent` skill:

```bash
# In Claude Code conversation
User: Use codeagent to implement authentication

# Claude will execute:
codeagent-wrapper --backend codex - <<'EOF'
implement JWT authentication in @src/auth
EOF
```

## Performance Tips

1. **Use parallel execution** for independent tasks
2. **Choose the right backend** for the task type
3. **Keep working directory specific** to reduce context
4. **Resume sessions** for multi-step workflows
5. **Use @ syntax** to minimize file content in prompts

## Best Practices

1. **HEREDOC for complex tasks** - Avoid shell escaping nightmares
2. **Descriptive task IDs** - Use `<feature>_<timestamp>` format
3. **Absolute paths** - Avoid relative path confusion
4. **Session resumption** - Continue conversations with context
5. **Cancellation** - Interrupt execution to stop the backend process tree

## Examples

### Example 1: Code Review

```bash
codeagent-wrapper --backend claude - <<'EOF'
Review @src/payment/stripe.ts for:
1. Security issues (API key handling, input validation)
2. Error handling (network failures, API errors)
3. Edge cases (duplicate charges, partial refunds)
4. Code quality (naming, structure, comments)
EOF
```

### Example 2: Refactoring

```bash
codeagent-wrapper --backend codex - <<'EOF'
Refactor @src/utils:
- Extract duplicate code into helpers
- Add TypeScript types
- Improve function naming
- Add JSDoc comments
EOF
```

### Example 3: Full-Stack Feature

```bash
codeagent-wrapper --parallel <<'EOF'
---TASK---
id: api_1701234567
workdir: /project/backend
---CONTENT---
implement /api/notifications endpoints with WebSocket support

---TASK---
id: ui_1701234568
workdir: /project/frontend
dependencies: api_1701234567
---CONTENT---
build Notifications component with real-time updates

---TASK---
id: tests_1701234569
workdir: /project
dependencies: api_1701234567, ui_1701234568
---CONTENT---
add E2E tests for notification flow
EOF
```

## Execution behavior

Positional task text takes priority over stdin. Piped input is read only when no task argument is supplied or when the task is explicit `-`.

For tasks beginning with `-`, use `codeagent-wrapper -- "- task"` or stdin `-`; these tasks automatically use backend stdin. For literal `cleanup`, `version`, or Cobra's automatic `help` tasks, use stdin `-` because these are subcommands. Worktrees are retained, and results show the path and branch. Use per-task `worktree: true` in parallel mode; `--worktree --parallel` is rejected.

For backend/model selection, single-task priority is explicit CLI flag > matching-backend agent preset > environment > config file > default. Parallel priority is explicit per-task field > global CLI flag (`--backend`/`--model`) > matching-backend agent preset > environment > config file > default. A global `--model` applies to every task without an explicit model; environment/config model defaults apply only to tasks using the global backend. Model, reasoning, and YOLO preset settings apply only when the selected backend matches the preset (case-insensitively). Invalid worker environment values (including whitespace and leading zeros) use 10. Parallel exit status follows the first failed task in definition order. Windows `.cmd`/`.bat` backends reject remaining argv containing `& | < > ^ % ! "`; task text is routed through stdin.

## Further Reading

- [Codex CLI Documentation](https://codex.docs)
- [Claude CLI Documentation](https://claude.ai/docs)
- [Gemini CLI Documentation](https://ai.google.dev/docs)
