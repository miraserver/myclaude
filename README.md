[中文](README_CN.md) [English](README.md)

# Claude Code Multi-Agent Workflow System

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Claude Code](https://img.shields.io/badge/Claude-Code-blue)](https://claude.ai/code)
[![Version](https://img.shields.io/badge/Version-6.x-green)](https://github.com/miraserver/myclaude)

> Fork of [stellarlinkco/myclaude](https://github.com/stellarlinkco/myclaude) with updated model defaults (claude-opus-5-5 / claude-sonnet-5-5 / gpt-6.1-sol), a working `do` Stop/verification gate and idempotent hook installation. Licensed under AGPL-3.0 like the original.

> AI-powered development automation with multi-backend execution (Codex/Claude/Gemini/OpenCode)

## Quick Start

```bash
npx github:miraserver/myclaude
```

## Prerequisites

- Node.js 18 or newer
- Python 3 (on Windows, the `py` launcher or `python`)
- Git
- Windows users: Git Bash for `.sh`-based skills such as `sparv`
- Backend CLIs installed and logged in as required by the module:

| Module | Backend CLIs |
|--------|--------------|
| `do` | Codex + Claude |
| `omo` | Codex + Claude + Gemini |
| `course` / `dev` | Codex |
| Other modules | None |

These requirements follow the agents and backends in [`config.json`](config.json); update the table if that configuration changes.

## Modules Overview

| Module | Description | Documentation |
|--------|-------------|---------------|
| [do](skills/do/README.md) | **Recommended** - 5-phase feature development with codeagent orchestration | `/do` command |
| [omo](skills/omo/README.md) | Multi-agent orchestration with intelligent routing | `/omo` command |
| [bmad](agents/bmad/README.md) | BMAD agile workflow with 6 specialized agents | `/bmad-pilot` command |
| [requirements](agents/requirements/README.md) | Lightweight requirements-to-code pipeline | `/requirements-pilot` command |
| [essentials](agents/development-essentials/README.md) | 11 core dev commands: ask, bugfix, code, debug, docs, enhance-prompt, optimize, refactor, review, test, think | `/code`, `/debug`, etc. |
| [sparv](skills/sparv/README.md) | SPARV workflow (Specify→Plan→Act→Review→Vault) | `/sparv` command |
| [harness](skills/harness/SKILL.md) | Multi-session autonomous agents with progress checkpoints, failure recovery, task dependencies, and self-reflection | `/harness` command |
| course | Course development (combines dev + product-requirements + test-cases) | Composite module |
| claudekit | Installs the dangerous-command guard (pre-bash) only; do is a separate module | Composite module |

### Available Skills

Individual skills can be installed separately via `npx github:miraserver/myclaude --list` (skills bundled in modules like do, omo, sparv are listed above):

| Skill | Description |
|-------|-------------|
| browser | Browser automation for web testing and data extraction |
| codeagent | codeagent-wrapper invocation for multi-backend AI code tasks |
| dev | Lightweight end-to-end development workflow |
| product-requirements | Interactive PRD generation with quality scoring |
| prototype-prompt-generator | Structured UI/UX prototype prompt generation |
| skill-install | Install skills from GitHub with security scanning |
| test-cases | Comprehensive test case generation from requirements |

## Installation

The npx installer ([`bin/cli.js`](bin/cli.js)) is the supported installer. `install.py` is legacy, kept for compatibility, and may lag behind.

```bash
# Interactive installer (recommended)
npx github:miraserver/myclaude

# List installable items (modules / skills / wrapper)
npx github:miraserver/myclaude --list

# Update installed modules and standalone skills to the latest release
npx github:miraserver/myclaude --update

# Custom install directory / overwrite
npx github:miraserver/myclaude --install-dir ~/.claude --force
```

`--update` detects installed modules and standalone skills in the target install directory (default: `~/.claude`, tracked in `installed_modules.json`) and updates them to the latest release. Standalone skills selected as `skill:<name>` are tracked, updated, and uninstalled like modules.

Global `CLAUDE.md` is no longer installed by default. Opt in with `--with-claude-md`; an existing `CLAUDE.md` is never overwritten:

```bash
npx github:miraserver/myclaude --with-claude-md
```

### Versions & releases

Releases are tags named `vX.Y.Z` on [github.com/miraserver/myclaude](https://github.com/miraserver/myclaude/releases). Pin a version with `npx github:miraserver/myclaude#vX.Y.Z`; use `--update` to update installed modules to the latest release.

Release assets include `SHA256SUMS`, which `install.sh`, `install.bat`, and the npx installer use to verify downloaded files.

### Module Configuration

Select modules to install in the interactive menu; editing a local `config.json` does not configure npx installations. Use `--module` to select modules for updates or removal:

```bash
npx github:miraserver/myclaude
npx github:miraserver/myclaude --update --module do,omo
npx github:miraserver/myclaude uninstall --module omo
```

## Workflow Selection Guide

| Scenario | Recommended |
|----------|-------------|
| Feature development (default) | `/do` |
| Bug investigation + fix | `/omo` |
| Large enterprise project | `/bmad-pilot` |
| Quick prototype | `/requirements-pilot` |
| Simple task | `/code`, `/debug` |

## Core Architecture

| Role | Agent | Responsibility |
|------|-------|----------------|
| **Orchestrator** | Claude Code | Planning, context gathering, verification |
| **Executor** | codeagent-wrapper | Code editing, test execution (Codex/Claude/Gemini/OpenCode) |

## Backend CLI Requirements

| Backend | Required Features |
|---------|-------------------|
| Codex | `codex e`, `--json`, `-C`, `resume` |
| Claude | `--output-format stream-json`, `-r` |
| Gemini | `-o stream-json`, `-y`, `-r` |
| OpenCode | `opencode`, stdin mode |

## Directory Structure After Installation

```
~/.claude/
├── bin/codeagent-wrapper  (Unix only)
├── CLAUDE.md              (opt-in: --with-claude-md)
├── commands/              (from essentials module)
├── agents/                (from bmad/requirements modules)
├── skills/                (from do/omo/sparv/course modules)
├── hooks/                 (from claudekit module)
├── settings.json          (auto-generated, hooks config)
└── installed_modules.json (tracks modules and standalone skills)
```

On Windows, the wrapper is installed to `%USERPROFILE%\bin\codeagent-wrapper.exe`, rather than `~/.claude/bin`.

## Security model

Nested Claude, Codex, and Gemini backends skip permission prompts or sandbox protections by default. To restore Claude permission prompts, set `CODEAGENT_SKIP_PERMISSIONS=false`; to disable Codex sandbox bypass, set `CODEX_BYPASS_SANDBOX=false`. Also set `yolo: false` for relevant agents in `~/.codeagent/models.json` and remove explicit `--skip-permissions` flags or task-level `skip-permissions: true`. The Gemini wrapper always adds `-y` and currently has no opt-out; for permission prompts or sandboxing, run the Gemini CLI directly without `-y` and enable its sandbox.

Harness hooks act only in projects activated through the harness skill and registered in `~/.claude/harness-state`. The `do` Stop hook only verifies tasks created by `/do` on this machine. Installers verify downloaded files against the release asset `SHA256SUMS` using SHA-256.

## Documentation

- [codeagent-wrapper](codeagent-wrapper/README.md)
- [Plugin System](PLUGIN_README.md)

## Troubleshooting

### Common Issues

**Codex wrapper not found:**
```bash
# Select: codeagent-wrapper
npx github:miraserver/myclaude
```

**Module not loading:**
```bash
cat ~/.claude/installed_modules.json
npx github:miraserver/myclaude --force
```

**Backend CLI errors:**
```bash
which codex && codex --version
which claude && claude --version
which gemini && gemini --version
```

## FAQ

| Issue | Solution |
|-------|----------|
| "Unknown event format" | Logging display issue, can be ignored |
| Gemini can't read .gitignore files | Remove from .gitignore or use different backend |
| Codex permission denied | Set `approval_policy = "never"` in ~/.codex/config.toml |

See [GitHub Issues](https://github.com/miraserver/myclaude/issues) for more.

## License

AGPL-3.0 - see [LICENSE](LICENSE)

### Commercial Licensing

For commercial use without AGPL obligations, contact: support@stellarlink.co

## Support

- [GitHub Issues](https://github.com/miraserver/myclaude/issues)
