---
name: do
description: This skill should be used for structured feature development with codebase understanding. Triggers on /do command. Provides a 5-phase workflow (Understand, Clarify, Design, Implement, Complete) using codeagent-wrapper to orchestrate code-explorer, code-architect, code-reviewer, and develop agents in parallel.
allowed-tools: ["Bash(python3:*/.claude/skills/do/scripts/setup-do.py*)", "Bash(python3:*/.claude/skills/do/scripts/task.py*)"]
---

# do - Feature Development Orchestrator

An orchestrator for systematic feature development. Invoke agents via `codeagent-wrapper`, never write code directly.

For every script call, use `python3` (on Windows, use `python` or `py -3` if `python3` is unavailable). Examples below use `python3`.

## Loop Initialization (REQUIRED)

When triggered via `/do <task>`, initialize the task directory immediately without asking about worktree:

```bash
python3 "$HOME/.claude/skills/do/scripts/setup-do.py" --verify "<cmd>" "<task description>"
```

When `--verify` is omitted, the project default is `.claude/do.json`:
```json
{"verify_command": "pnpm typecheck && pnpm test"}
```

This creates a task directory under `.claude/do-tasks/` with:
- `task.md`: Single file containing YAML frontmatter (metadata) + Markdown body (requirements/context)

**Worktree decision is deferred until Phase 4 (Implement).** Phases 1-3 are read-only and do not require worktree isolation.

## Task Directory Management

Use `task.py` to manage task state:

```bash
# Update phase
python3 "$HOME/.claude/skills/do/scripts/task.py" update-phase 2

# Check status
python3 "$HOME/.claude/skills/do/scripts/task.py" status

# List all tasks
python3 "$HOME/.claude/skills/do/scripts/task.py" list
```

## Verification Gate

When the phase reaches its maximum, the Stop hook runs `verify_command` from the user-local `~/.claude/do-state/registry.json`, recorded by task creation or `set-verify`; the copy in `task.md` is informational. Only registered tasks are gated. It blocks for up to five attempts with failing output and marks the task completed when verification passes. The task binds to the session that first stops; abandon it with `task.py finish`, and change the command with `set-verify`.

Setting `status: "cancelled"` skips blocking and verification. On a `verify_failed` task, `set-verify` resets the verification attempt budget and returns the task to `in_progress`. `DO_VERIFY_TIMEOUT` sets the timeout in seconds (default 1500); timed-out verification kills the command's process tree and collects output for at most five more seconds.

## Worktree Mode

The worktree is created **only when needed** (right before Phase 4: Implement). If the user chooses worktree mode:

1. Attach a worktree to the current task, preserving its phase and verification settings:
   ```bash
   python3 "$HOME/.claude/skills/do/scripts/task.py" worktree
   ```

2. Use the `DO_WORKTREE_DIR` environment variable to direct every later `codeagent-wrapper` call that needs the implementation into the worktree, including development, review, verification, and completion. **Never pass `--worktree` after initialization** — that creates a new worktree each time.

```bash
# Save the worktree path from task.py output, then prefix all implementation-dependent calls:
DO_WORKTREE_DIR="<worktree_dir>" codeagent-wrapper --agent develop - . <<'EOF'
...
EOF
```

The wrapper applies `DO_WORKTREE_DIR` to every agent, including read-only agents, in both single and parallel calls; it overrides the positional directory and each task's `workdir`. Alternatively, pass the worktree directory as the single call's positional directory or set `workdir: <worktree_dir>` in every parallel task, with `DO_WORKTREE_DIR` unset. Phases 1-3 can use the original checkout before the worktree exists. After initialization, all agents inspecting the implementation must use the worktree. Run any direct verification commands there too; the Stop hook uses the attached worktree automatically.

## Hard Constraints

1. **Never write code directly.** Delegate all code changes to `codeagent-wrapper` agents.
2. **Parallel-first.** Run independent tasks via `codeagent-wrapper --parallel`.
3. **Update phase after each phase.** Use `task.py update-phase <N>`.
4. **Expect long-running `codeagent-wrapper` calls.** High-reasoning modes can take a long time.
5. **Timeouts are not an escape hatch.** If a call times out, retry with narrower scope.
6. **Defer worktree decision until Phase 4.** Only ask about worktree mode right before implementation. If enabled, prefix every later implementation-dependent agent call (including review, verification, fixes, and completion) with `DO_WORKTREE_DIR="<path>"`. Never pass `--worktree` after initialization.

## Agents

| Agent | Purpose | Directory after worktree initialization |
|-------|---------|-----------------------------------------|
| `code-explorer` | Trace code, map architecture, find patterns | Worktree when inspecting implementation |
| `code-architect` | Design approaches, file plans, build sequences | Worktree when inspecting implementation |
| `code-reviewer` | Review for bugs, simplicity, conventions | Worktree (including completion summary) |
| `develop` | Implement code, run tests | Worktree |

## Issue Severity Definitions

**Blocking issues** (require user input):
- Impacts core functionality or correctness
- Security vulnerabilities
- Architectural conflicts with existing patterns
- Ambiguous requirements with multiple valid interpretations

**Minor issues** (auto-fix without asking):
- Code style inconsistencies
- Naming improvements
- Missing documentation
- Non-critical test coverage gaps

## 5-Phase Workflow

### Phase 1: Understand (Parallel, No Interaction)

**Goal:** Understand requirements and map codebase simultaneously.

**Actions:** Run `code-architect` and 2-3 `code-explorer` tasks in parallel.

```bash
codeagent-wrapper --parallel <<'EOF'
---TASK---
id: p1_requirements
agent: code-architect
workdir: .
---CONTENT---
Analyze requirements completeness (score 1-10):
1. Extract explicit requirements, constraints, acceptance criteria
2. Identify blocking questions (issues that prevent implementation)
3. Identify minor clarifications (nice-to-have but can proceed without)

Output format:
- Completeness score: X/10
- Requirements: [list]
- Non-goals: [list]
- Blocking questions: [list, if any]

---TASK---
id: p1_similar_features
agent: code-explorer
workdir: .
---CONTENT---
Find 1-3 similar features, trace end-to-end. Return: key files with line numbers, call flow, extension points.

---TASK---
id: p1_architecture
agent: code-explorer
workdir: .
---CONTENT---
Map architecture for relevant subsystem. Return: module map + 5-10 key files.

---TASK---
id: p1_conventions
agent: code-explorer
workdir: .
---CONTENT---
Identify testing patterns, conventions, config. Return: test commands + file locations.
EOF
```

### Phase 2: Clarify (Conditional)

**Goal:** Resolve blocking ambiguities only.

**Actions:**
1. Review `p1_requirements` output for blocking questions
2. **IF blocking questions exist** → Use AskUserQuestion
3. **IF no blocking questions (completeness >= 8)** → Skip to Phase 3

### Phase 3: Design (No Interaction)

**Goal:** Produce minimal-change implementation plan.

```bash
codeagent-wrapper --agent code-architect - . <<'EOF'
Design minimal-change implementation:
- Reuse existing abstractions
- Minimize new files
- Follow established patterns from Phase 1 exploration

Output:
- File touch list with specific changes
- Build sequence
- Test plan
- Risks and mitigations
EOF
```

### Phase 4: Implement + Review

**Goal:** Build feature and review in one phase.

**Step 1: Decide on worktree mode (ONLY NOW)**

Use AskUserQuestion to ask:

```
Develop in a separate worktree? (Isolates changes from main branch)
- Yes (Recommended for larger changes)
- No (Work directly in current directory)
```

If user chooses worktree:
```bash
python3 "$HOME/.claude/skills/do/scripts/task.py" worktree
# Save the worktree path from output for DO_WORKTREE_DIR
```

**Step 2: Invoke develop agent**

For full-stack projects, split into backend/frontend tasks with per-task `skills:` injection. Use `--parallel` when tasks can be split; use single agent when the change is small or single-domain.

**Single-domain example** (prefix with `DO_WORKTREE_DIR` if worktree enabled):

```bash
# With worktree:
DO_WORKTREE_DIR="<worktree_dir>" codeagent-wrapper --agent develop --skills golang-base-practices - . <<'EOF'
Implement with minimal change set following the Phase 3 blueprint.
- Follow Phase 1 patterns
- Add/adjust tests per Phase 3 plan
- Run narrowest relevant tests
EOF

# Without worktree:
codeagent-wrapper --agent develop --skills golang-base-practices - . <<'EOF'
Implement with minimal change set following the Phase 3 blueprint.
- Follow Phase 1 patterns
- Add/adjust tests per Phase 3 plan
- Run narrowest relevant tests
EOF
```

**Full-stack parallel example** (adapt task IDs, skills, and content based on Phase 3 design):

```bash
# With worktree:
DO_WORKTREE_DIR="<worktree_dir>" codeagent-wrapper --parallel <<'EOF'
---TASK---
id: p4_backend
agent: develop
workdir: .
skills: golang-base-practices
---CONTENT---
Implement backend changes following Phase 3 blueprint.
- Follow Phase 1 patterns
- Add/adjust tests per Phase 3 plan

---TASK---
id: p4_frontend
agent: develop
workdir: .
skills: frontend-design,vercel-react-best-practices
dependencies: p4_backend
---CONTENT---
Implement frontend changes following Phase 3 blueprint.
- Follow Phase 1 patterns
- Add/adjust tests per Phase 3 plan
EOF

# Without worktree: remove DO_WORKTREE_DIR prefix
```

Note: Choose which skills to inject based on Phase 3 design output. Only inject skills relevant to each task's domain.

**Step 3: Review**

Run parallel reviews in the implementation checkout:

```bash
# With worktree (without worktree: remove DO_WORKTREE_DIR prefix):
DO_WORKTREE_DIR="<worktree_dir>" codeagent-wrapper --parallel <<'EOF'
---TASK---
id: p4_correctness
agent: code-reviewer
workdir: .
---CONTENT---
Review for correctness, edge cases, failure modes.
Classify each issue as BLOCKING or MINOR.

---TASK---
id: p4_simplicity
agent: code-reviewer
workdir: .
---CONTENT---
Review for KISS: remove bloat, collapse needless abstractions.
Classify each issue as BLOCKING or MINOR.
EOF
```

**Step 4: Handle review results**

- **MINOR issues only** → Auto-fix via `develop` in the same implementation checkout, no user interaction
- **BLOCKING issues** → Use AskUserQuestion: "Fix now / Proceed as-is"

### Phase 5: Complete (No Interaction)

**Goal:** Document what was built.

```bash
# With worktree (without worktree: remove DO_WORKTREE_DIR prefix):
DO_WORKTREE_DIR="<worktree_dir>" codeagent-wrapper --agent code-reviewer - . <<'EOF'
Write completion summary:
- What was built
- Key decisions/tradeoffs
- Files modified (paths)
- How to verify (commands)
- Follow-ups (optional)
EOF
```

Before printing the completion promise, run:
```bash
python3 "$HOME/.claude/skills/do/scripts/task.py" update-phase 5
```

Output the completion signal:
```
<promise>DO_COMPLETE</promise>
```
