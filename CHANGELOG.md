# Changelog

All notable changes to this project will be documented in this file.

## [6.11.1] - 2026-10-22

### Bug Fixes

- Fix legacy `merge_dir` uninstall ownership, preserve shared course/standalone files, and relocate restored agent `prompt_file` paths.
- Detect lost wrapper final output as a failure while ignoring trailing output after completion.
- Withdraw releases only after smoke-test failures; decode hook stdin with BOM support.
- Handle corrupt `do` registries, retry registry lock-file opens, and quote `DO_WORKTREE_DIR` exports.
- Lock SPARV project registry updates and support bmad reviews without a sprint plan.

### Notes

- Installs recorded by v6.10.0 or older, and v6.10.1 `merge_dir` files, have no per-file hashes. The first `--update` cannot detect local edits and overwrites them; protection applies from the next update on. Back up edited files first.
- SPARV sessions initialized before 6.11.0 must rerun `init-session.sh` without `--force` to re-enable hooks.

## [6.11.0] - 2026-10-22

### Security

- Decode hook payloads as UTF-8 on Windows ANSI code pages, fixing a pre-bash guard bypass with non-ASCII commands.
- Never overwrite registries on read errors.
- Hold an OS lock for harness/do registry writes; it is released automatically if the process dies.

### Bug Fixes

- Restore the previous wrapper in `install.bat` when verification fails.
- Prevent the sparv Stop hook from blocking forever by handling archived sessions, escalation limits, and `stop_hook_active`; act only in projects initialised on this machine.
- Review the worktree in `/do` worktree mode.
- Load bundled prompts for `/do` agents.
- Support `python3` fallbacks on Windows.
- Log wrapper backend output in parallel mode and report truncated final output and OpenCode error events as failures.
- Preserve uninstall/update ownership with merged hash records, no deletion of unowned files, tracked `merge_dir` files, and shared files kept between course and standalone skills.
- Preserve identical user hooks.
- Install the wrapper with the standalone codeagent skill.
- Relocate prompt paths for `--install-dir`.
- Support bmad `--direct-dev` without a sprint plan.

### Changed

- Keep locally modified module files during `--update`; use `--force` to overwrite them.
- Automatically withdraw a release to draft when the post-release smoke test fails.

## [6.10.1] - 2026-10-22

### 🐛 Bug Fixes

- Lock harness/do registries and make them Windows-safe under concurrent sessions.
- Track per-file SHA-256 ownership during uninstall so modules installed by older releases are removed fully; keep the registry entry for partial uninstalls.
- Correct docs to select release content with `--tag vX.Y.Z`; repository `#ref` only selects installer code.

## [6.10.0] - 2026-10-22

### 🚀 Features

- Make global `CLAUDE.md` opt-in with `--with-claude-md`; never overwrite an existing file.
- Track standalone skills (`skill:<name>`) for updates and uninstall, like modules.
- Show the installed module version in status output.
- Restrict harness hooks to projects activated through the harness skill and registered in `~/.claude/harness-state`.
- Add a post-release installation smoke test in CI.

### 🐛 Bug Fixes

- Warn when latest-release tag lookup fails instead of silently falling back.
- Fix Windows SHA256SUMS parsing in install.bat when GitHub serves the manifest as application/octet-stream (PowerShell 5.1 returned bytes; every wrapper install failed with a checksum mismatch in 6.9.5/6.9.6).

### ⚠️ Upgrade notes

- Harness runs activated before this release are not registered; run /harness run once in such projects to re-activate.

## [6.9.6] - 2026-10-22

### 🐛 Bug Fixes

- Fix Windows SHA256 verification under delayed expansion; exercise the batch verification label through real `cmd.exe`.
- Register only the claudekit pre-bash guard; remove no-op spec injection and unused prompt logging, and move hook tests outside installed files.

## [6.9.5] - 2026-10-22

### 🐛 Bug Fixes

- Fix wrapper stdin handling, explicit permission settings, parallel configuration priority, Unicode skill truncation, and temporary-directory cleanup.
- Use a user-local `do` task registry for verification commands and resolve verification directories relative to worktrees.
- Handle locked Windows executables and fix harness lease locking, claim/rollback, SPARV, browser, and skill-install behavior.
- Run script tests across three operating systems and normalize temporary paths on macOS and Windows.

### 🔒 Security

- Verify downloaded assets against release `SHA256SUMS`; check release versions and restrict CI permissions.
- Preserve file ownership during uninstall and model merges, and protect `models.json` permissions.
- Read pre-bash commands from stdin and block dangerous commands with exit code 2.

## [6.9.4] - 2026-10-22

### 🐛 Bug Fixes

- Fix installer rollback, update selection scope, Windows launch, and the codeagent skill dependency.
- Merge `do` model settings safely and mark agent ownership with `__module__`.
- Fix wrapper stdin/argument handling, configuration priority, worktree handling, and exit codes.
- Correct browser script references, WebSocket resolution, and SPARV state paths; expand CI to three operating systems and correct previous-tag detection.

## [6.9.3] - 2026-10-22

### 🐛 Bug Fixes

- Install the dev-plan-generator subagent and preserve unowned single-file installation targets.
- Bound `do` verification timeouts, track cancellation, restart verification setup, and match hooks precisely.
- Fix harness subagent stop ownership, empty-list initialization, reflection counting, and transcript parsing.

## [6.9.2] - 2026-10-22

### 🐛 Bug Fixes

- Fix Windows wrapper paths, tagged downloads, and offline installation.
- Terminate the whole wrapper process tree on cancellation, honor agent settings, retain stdout tails, and remove Gemini prompt echo.
- Attach worktrees to the current `do` task, resolve OmO role prompts from installed paths, and support non-UTF-8 consoles in harness hooks.

### 🔒 Security

- Preserve corrupt JSON and unowned user files instead of overwriting them during installation.

## [6.9.1] - 2026-10-21

### 🐛 Bug Fixes

- Invoke `install.bat` by absolute path and use CRLF line endings for batch files.

## [6.9.0] - 2026-10-21

### 🚀 Features

- Rebrand the fork as `miraserver/myclaude` and update default models to Claude Opus 5.5, Claude Sonnet 5.5, and GPT-6.1-sol.
- Add a working `do` Stop gate with a task verification loop.

### 🐛 Bug Fixes

- Reconcile hooks idempotently, preserve user-edited model agents, and remove only module-owned files and hooks on uninstall.
- Pass Claude reasoning effort to the backend and build with Go 1.26 for compatibility with current macOS.

## [6.8.0]

Reconstructed from pre-6.9.0 history after 6.7.0; this checkout has no `v6.8.0` tag, so the exact release boundary and date are unavailable.

### 🚀 Features

- Add the harness skill with hook installation, removal, and explicit reflection markers.
- Add structured JSON output and progress frames to codeagent-wrapper; refactor wrapper runtime boundaries.

### 🐛 Bug Fixes

- Fix installer bootstrap and offline fallback, `do` worktree handling, and absolute skill script paths.
- Isolate nested Claude temporary directories and clear `CLAUDECODE` to avoid nested-session rejection.
- Retain wrapper logs and parsed errors, remove summary truncation, filter Codex stderr noise, and fix macOS symlink cleanup.
- Improve Windows temporary paths and remove forced Claude setting sources.

## [6.7.0] - 2026-02-10

### 🚀 Features

- feat(install): per-module agent merge/unmerge for ~/.codeagent/models.json
- feat(install): post-install verification (wrapper version, PATH, backend CLIs)
- feat(install): install CLAUDE.md by default
- feat(docs): document 9 skills, 11 commands, claudekit module, OpenCode backend

### 🐛 Bug Fixes

- fix(docs): correct 7-phase → 5-phase for do skill across all docs
- fix(install): best-effort default config install (never crashes main flow)
- fix(install): interactive quit no longer triggers post-install actions
- fix(install): empty parent directory cleanup on copy_file uninstall
- fix(install): agent restore on uninstall when shared by multiple modules
- fix(docs): remove non-existent on-stop hook references

### 📚 Documentation

- Updated USER_GUIDE.md with 13 CLI flags and OpenCode backend
- Updated README.md/README_CN.md with complete module and skill listings
- Added templates/models.json.example with all agent presets (do + omo)

## [6.6.0] - 2026-02-10

### 🚀 Features

- feat(skills): add per-task skill spec auto-detection and injection
- feat: add worktree support and refactor do skill to Python

### 🐛 Bug Fixes

- fix(test): set USERPROFILE on Windows for skills tests
- fix(do): reuse worktree across phases via DO_WORKTREE_DIR env var
- fix(release): auto-generate release notes from git history

### 📚 Documentation

- audit and fix documentation, installation scripts, and default configuration

## [6.0.0] - 2026-01-26

### 🚀 Features

- support `npx github:stellarlinkco/myclaude` for installation and execution
- default module changed from `dev` to `do`

### 🚜 Refactor

- restructure: create `agents/` and move `bmad-agile-workflow` → `agents/bmad`, `requirements-driven-workflow` → `agents/requirements`, `development-essentials` → `agents/development-essentials`
- remove legacy directories: `docs/`, `hooks/`, `dev-workflow/`
- update references across `config.json`, `README.md`, `README_CN.md`, `marketplace.json`, etc.

### 📚 Documentation

- add `skills/README.md` and `PLUGIN_README.md`

### 💼 Other

- add `package.json` and `bin/cli.js` for npx packaging

## [6.1.5] - 2026-01-25


### 🐛 Bug Fixes


- correct gitignore to not exclude cmd/codeagent-wrapper

## [6.1.4] - 2026-01-25


### 🐛 Bug Fixes


- support concurrent tasks with unique state files

## [6.1.3] - 2026-01-25


### 🐛 Bug Fixes


- correct build path in release workflow

- increase stdoutDrainTimeout from 100ms to 500ms

## [6.1.2] - 2026-01-24


### 🐛 Bug Fixes


- use ANTHROPIC_AUTH_TOKEN for Claude CLI env injection

### 💼 Other


- update codeagent version

### 📚 Documentation


- restructure root READMEs with do as recommended workflow

- update do/omo/sparv module READMEs with detailed workflows

- add README for bmad and requirements modules

### 🧪 Testing


- use prefix match for version flag tests

## [6.1.1] - 2026-01-23


### 🚜 Refactor


- rename feature-dev to do workflow

## [6.1.0] - 2026-01-23


### ⚙️ Miscellaneous Tasks


- ignore references directory

- add go.work.sum for workspace dependencies

### 🐛 Bug Fixes


- read GEMINI_MODEL from ~/.gemini/.env ([#131](https://github.com/stellarlinkco/myclaude/issues/131))

- validate non-empty output message before printing

### 🚀 Features


- add feature-dev skill with 7-phase workflow

- support \${CLAUDE_PLUGIN_ROOT} variable in hooks config

## [6.0.0-alpha1] - 2026-01-20


### 🐛 Bug Fixes


- add missing cmd/codeagent/main.go entry point

- update release workflow build path for new directory structure

- write PATH config to both profile and rc files ([#128](https://github.com/stellarlinkco/myclaude/issues/128))

### 🚀 Features


- add course module with dev, product-requirements and test-cases skills

- add hooks management to install.py

### 🚜 Refactor


- restructure codebase to internal/ directory with modular architecture

## [5.6.7] - 2026-01-17


### 💼 Other


- remove .sparv

### 📚 Documentation


- update 'Agent Hierarchy' model for frontend-ui-ux-engineer and document-writer in README ([#127](https://github.com/stellarlinkco/myclaude/issues/127))

- update mappings for frontend-ui-ux-engineer and document-writer in README ([#126](https://github.com/stellarlinkco/myclaude/issues/126))

### 🚀 Features


- add sparv module and interactive plugin manager

- add sparv enhanced rules v1.1

- add sparv skill to claude-plugin v1.1.0

- feat sparv skill

## [5.6.6] - 2026-01-16


### 🐛 Bug Fixes


- remove extraneous dash arg for opencode stdin mode ([#124](https://github.com/stellarlinkco/myclaude/issues/124))

### 💼 Other


- update readme

## [5.6.5] - 2026-01-16


### 🐛 Bug Fixes


- correct default models for oracle and librarian agents ([#120](https://github.com/stellarlinkco/myclaude/issues/120))

### 🚀 Features


- feat dev skill

## [5.6.4] - 2026-01-15


### 🐛 Bug Fixes


- filter codex 0.84.0 stderr noise logs ([#122](https://github.com/stellarlinkco/myclaude/issues/122))

- filter codex stderr noise logs

## [5.6.3] - 2026-01-14


### ⚙️ Miscellaneous Tasks


- bump codeagent-wrapper version to 5.6.3

### 🐛 Bug Fixes


- update version tests to match 5.6.3

- use config override for codex reasoning effort

## [5.6.2] - 2026-01-14


### 🐛 Bug Fixes


- propagate SkipPermissions to parallel tasks ([#113](https://github.com/stellarlinkco/myclaude/issues/113))

- add timeout for Windows process termination

- reject dash as workdir parameter ([#118](https://github.com/stellarlinkco/myclaude/issues/118))

### 📚 Documentation


- add OmO workflow to README and fix plugin marketplace structure

### 🚜 Refactor


- remove sisyphus agent and unused code

## [5.6.1] - 2026-01-13


### 🐛 Bug Fixes


- add sleep in fake script to prevent CI race condition

- fix gemini env load

- fix omo

### 🚀 Features


- add reasoning effort config for codex backend

## [5.6.0] - 2026-01-13


### 📚 Documentation


- update FAQ for default bypass/skip-permissions behavior

### 🚀 Features


- default to skip-permissions and bypass-sandbox

- add omo module for multi-agent orchestration

### 🚜 Refactor


- streamline agent documentation and remove sisyphus

## [5.5.0] - 2026-01-12


### 🐛 Bug Fixes


- 修复 Gemini init 事件 session_id 未提取的问题 ([#111](https://github.com/stellarlinkco/myclaude/issues/111))

- fix codeagent skill TaskOutput

### 💼 Other


- Merge branch 'master' of github.com:stellarlinkco/myclaude

- add test-cases skill

- add browser skill

### 🚀 Features


- add multi-agent support with yolo mode

## [5.4.4] - 2026-01-08


### 💼 Other


- 修复 Windows 后端退出：taskkill 结束进程树 + turn.completed 支持 ([#108](https://github.com/stellarlinkco/myclaude/issues/108))

## [5.4.3] - 2026-01-06


### 🐛 Bug Fixes


- support model parameter for all backends, auto-inject from settings ([#105](https://github.com/stellarlinkco/myclaude/issues/105))

### 📚 Documentation


- add FAQ Q5 for permission/sandbox env vars

### 🚀 Features


- feat skill-install install script and security scan

- add uninstall scripts with selective module removal

## [5.4.2] - 2025-12-31


### 🐛 Bug Fixes


- replace setx with reg add to avoid 1024-char PATH truncation ([#101](https://github.com/stellarlinkco/myclaude/issues/101))

## [5.4.1] - 2025-12-26


### 🐛 Bug Fixes


- 移除未知事件格式的日志噪声 ([#96](https://github.com/stellarlinkco/myclaude/issues/96))

- prevent duplicate PATH entries on reinstall ([#95](https://github.com/stellarlinkco/myclaude/issues/95))

### 📚 Documentation


- 添加 FAQ 常见问题章节

- update troubleshooting with idempotent PATH commands ([#95](https://github.com/stellarlinkco/myclaude/issues/95))

### 🚀 Features


- Add intelligent backend selection based on task complexity ([#61](https://github.com/stellarlinkco/myclaude/issues/61))

## [5.4.0] - 2025-12-24


### 🐛 Bug Fixes


- Minor issues #12 and #13 - ASCII mode and performance optimization

- code review fixes for PR #94 - all critical and major issues resolved

### 🚀 Features


- v5.4.0 structured execution report ([#94](https://github.com/stellarlinkco/myclaude/issues/94))

## [5.2.8] - 2025-12-22


### ⚙️ Miscellaneous Tasks


- simplify release workflow to use GitHub auto-generated notes

### 🐛 Bug Fixes


- correct settings.json filename and bump version to v5.2.8

## [5.2.7] - 2025-12-21


### ⚙️ Miscellaneous Tasks


- bump version to v5.2.7

### 🐛 Bug Fixes


- allow claude backend to read env from setting.json while preventing recursion ([#92](https://github.com/stellarlinkco/myclaude/issues/92))

- comprehensive security and quality improvements for PR #85 & #87 ([#90](https://github.com/stellarlinkco/myclaude/issues/90))

- Parser重复解析优化 + 严重bug修复 + PR #86兼容性 ([#88](https://github.com/stellarlinkco/myclaude/issues/88))

### 💼 Other


- Improve backend termination after message and extend timeout ([#86](https://github.com/stellarlinkco/myclaude/issues/86))

### 🚀 Features


- add millisecond-precision timestamps to all log entries ([#91](https://github.com/stellarlinkco/myclaude/issues/91))

## [5.2.6] - 2025-12-19


### 🐛 Bug Fixes


- filter noisy stderr output from gemini backend ([#83](https://github.com/stellarlinkco/myclaude/issues/83))

- 修復 wsl install.sh 格式問題 ([#78](https://github.com/stellarlinkco/myclaude/issues/78))

### 💼 Other


- update all readme

- BMADh和Requirements-Driven支持根据语义生成对应的文档 ([#82](https://github.com/stellarlinkco/myclaude/issues/82))

## [5.2.5] - 2025-12-17


### 🐛 Bug Fixes


- 修复多 backend 并行日志 PID 混乱并移除包装格式 ([#74](https://github.com/stellarlinkco/myclaude/issues/74)) ([#76](https://github.com/stellarlinkco/myclaude/issues/76))

- replace "Codex" to "codeagent" in dev-plan-generator subagent

- 修復 win python install.py

### 💼 Other


- Merge pull request #71 from aliceric27/master

- Merge branch 'stellarlinkco:master' into master

- Merge pull request #72 from changxvv/master

- update changelog

- update codeagent skill backend select

## [5.2.4] - 2025-12-16


### ⚙️ Miscellaneous Tasks


- integrate git-cliff for automated changelog generation

- bump version to 5.2.4

### 🐛 Bug Fixes


- 防止 Claude backend 无限递归调用

- isolate log files per task in parallel mode

### 💼 Other


- Merge pull request #70 from stellarlinkco/fix/prevent-codeagent-infinite-recursion

- Merge pull request #69 from stellarlinkco/myclaude-master-20251215-073053-338465000

- update CHANGELOG.md

- Merge pull request #65 from stellarlinkco/fix/issue-64-buffer-overflow

## [5.2.3] - 2025-12-15


### 🐛 Bug Fixes


- 修复 bufio.Scanner token too long 错误 ([#64](https://github.com/stellarlinkco/myclaude/issues/64))

### 💼 Other


- change version

### 🧪 Testing


- 同步测试中的版本号至 5.2.3

## [5.2.2] - 2025-12-13


### ⚙️ Miscellaneous Tasks


- Bump version and clean up documentation

### 🐛 Bug Fixes


- fix codeagent backend claude no auto

- fix install.py dev fail

### 🧪 Testing


- Fix tests for ClaudeBackend default --dangerously-skip-permissions

## [5.2.1] - 2025-12-13


### 🐛 Bug Fixes


- fix codeagent claude and gemini root dir

### 💼 Other


- update readme

## [5.2.0] - 2025-12-13


### ⚙️ Miscellaneous Tasks


- Update CHANGELOG and remove deprecated test files

### 🐛 Bug Fixes


- fix race condition in stdout parsing

- add worker limit cap and remove legacy alias

- use -r flag for gemini backend resume

- clarify module list shows default state not enabled

- use -r flag for claude backend resume

- remove binary artifacts and improve error messages

- 异常退出时显示最近错误信息

- op_run_command 实时流式输出

- 修复权限标志逻辑和版本号测试

- 重构信号处理逻辑避免重复 nil 检查

- 移除 .claude 配置文件验证步骤

- 修复并行执行启动横幅重复打印问题

- 修复master合并后的编译和测试问题

### 💼 Other


- Merge rc/5.2 into master: v5.2.0 release improvements

- Merge pull request #53 from stellarlinkco/rc/5.2

- remove docs

- remove docs

- add prototype prompt skill

- add prd skill

- update memory claude

- remove command gh flow

- update license

- Merge branch 'master' into rc/5.2

- Merge pull request #52 from stellarlinkco/fix/parallel-log-path-on-startup

### 📚 Documentation


- remove GitHub workflow related content

### 🚀 Features


- Complete skills system integration and config cleanup

- Improve release notes and installation scripts

- 添加终端日志输出和 verbose 模式

- 完整多后端支持与安全优化

- 替换 Codex 为 codeagent 并添加 UI 自动检测

### 🚜 Refactor


- 调整文件命名和技能定义

### 🧪 Testing


- 添加 ExtractRecentErrors 单元测试

## [5.1.4] - 2025-12-09


### 🐛 Bug Fixes


- 任务启动时立即返回日志文件路径以支持实时调试

## [5.1.3] - 2025-12-08


### 🐛 Bug Fixes


- resolve CI timing race in TestFakeCmdInfra

## [5.1.2] - 2025-12-08


### 🐛 Bug Fixes


- 修复channel同步竞态条件和死锁问题

### 💼 Other


- Merge pull request #51 from stellarlinkco/fix/channel-sync-race-conditions

- change codex-wrapper version

## [5.1.1] - 2025-12-08


### 🐛 Bug Fixes


- 增强日志清理的安全性和可靠性

- resolve data race on forceKillDelay with atomic operations

### 💼 Other


- Merge pull request #49 from stellarlinkco/freespace8/master

- resolve signal handling conflict preserving testability and Windows support

### 🧪 Testing


- 补充测试覆盖提升至 89.3%

## [5.1.0] - 2025-12-07


### 💼 Other


- Merge pull request #45 from Michaelxwb/master

- 修改windows安装说明

- 修改打包脚本

- 支持windows系统的安装

- Merge pull request #1 from Michaelxwb/feature-win

- 支持window

### 🚀 Features


- 添加启动时清理日志的功能和--cleanup标志支持

- implement enterprise workflow with multi-backend support

## [5.0.0] - 2025-12-05


### ⚙️ Miscellaneous Tasks


- clarify unit-test coverage levels in requirement questions

### 🐛 Bug Fixes


- defer startup log until args parsed

### 💼 Other


- Merge branch 'master' of github.com:stellarlinkco/myclaude

- Merge pull request #43 from gurdasnijor/smithery/add-badge

- Add Smithery badge

- Merge pull request #42 from freespace8/master

### 📚 Documentation


- rewrite documentation for v5.0 modular architecture

### 🚀 Features


- feat install.py

- implement modular installation system

### 🚜 Refactor


- remove deprecated plugin modules

## [4.8.2] - 2025-12-02


### 🐛 Bug Fixes


- skip signal test in CI environment

- make forceKillDelay testable to prevent signal test timeout

- correct Go version in go.mod from 1.25.3 to 1.21

- fix codex wrapper async log

- capture and include stderr in error messages

### 💼 Other


- Merge pull request #41 from stellarlinkco/fix-async-log

- remove test case 90

- optimize codex-wrapper

- Merge branch 'master' into fix-async-log

## [4.8.1] - 2025-12-01


### 🎨 Styling


- replace emoji with text labels

### 🐛 Bug Fixes


- improve --parallel parameter validation and docs

### 💼 Other


- remove codex-wrapper bin

## [4.8.0] - 2025-11-30


### 💼 Other


- update codex skill dependencies

## [4.7.3] - 2025-11-29


### 🐛 Bug Fixes


- 保留日志文件以便程序退出后调试并完善日志输出功能

### 💼 Other


- Merge pull request #34 from stellarlinkco/cce-worktree-master-20251129-111802-997076000

- update CLAUDE.md and codex skill

### 📚 Documentation


- improve codex skill parameter best practices

### 🚀 Features


- add session resume support and improve output format

- add parallel execution support to codex-wrapper

- add async logging to temp file with lifecycle management

## [4.7.2] - 2025-11-28


### 🐛 Bug Fixes


- improve buffer size and streamline message extraction

### 💼 Other


- Merge pull request #32 from freespace8/master

### 🧪 Testing


- 增加对超大单行文本和非字符串文本的处理测试

## [4.7.1] - 2025-11-27


### 💼 Other


- optimize dev pipline

- Merge feat/codex-wrapper: fix repository URLs

## [4.7] - 2025-11-27


### 🐛 Bug Fixes


- update repository URLs to stellarlinkco/myclaude

## [4.7-alpha1] - 2025-11-27


### 🐛 Bug Fixes


- fix marketplace schema validation error in dev-workflow plugin

### 💼 Other


- Merge pull request #29 from stellarlinkco/feat/codex-wrapper

- Add codex-wrapper Go implementation

- update readme

- update readme

## [4.6] - 2025-11-25


### 💼 Other


- update dev workflow

- update dev workflow

## [4.5] - 2025-11-25


### 🐛 Bug Fixes


- fix codex skill eof

### 💼 Other


- update dev workflow plugin

- update readme

## [4.4] - 2025-11-22


### 🐛 Bug Fixes


- fix codex skill timeout and add more log

- fix codex skill

### 💼 Other


- update gemini skills

- update dev workflow

- update codex skills model config

- Merge branch 'master' of github.com:stellarlinkco/myclaude

- Merge pull request #24 from stellarlinkco/swe-agent/23-1763544297

### 🚀 Features


- 支持通过环境变量配置 skills 模型

## [4.3] - 2025-11-19


### 🐛 Bug Fixes


- fix codex skills running

### 💼 Other


- update skills plugin

- update gemini

- update doc

- Add Gemini CLI integration skill

### 🚀 Features


- feat simple dev workflow

## [4.2.2] - 2025-11-15


### 💼 Other


- update codex skills

## [4.2.1] - 2025-11-14


### 💼 Other


- Merge pull request #21 from Tshoiasc/master

- Merge branch 'master' into master

- Change default model to gpt-5.1-codex

- Enhance codex.py to auto-detect long inputs and switch to stdin mode, improving handling of shell argument issues. Updated build_codex_args to support stdin and added relevant logging for task length warnings.

## [4.2] - 2025-11-13


### 🐛 Bug Fixes


- fix codex.py wsl run err

### 💼 Other


- optimize codex skills

- Merge branch 'master' of github.com:stellarlinkco/myclaude

- Rename SKILLS.md to SKILL.md

- optimize codex skills

### 🚀 Features


- feat codex skills

## [4.1] - 2025-11-04


### 💼 Other


- update enhance-prompt.md response

- update readme

### 📚 Documentation


- 新增 /enhance-prompt 命令并更新所有 README 文档

## [4.0] - 2025-10-22


### 🐛 Bug Fixes


- fix skills format

### 💼 Other


- Merge branch 'master' of github.com:stellarlinkco/myclaude

- Merge pull request #18 from stellarlinkco/swe-agent/17-1760969135

- update requirements clarity

- update .gitignore

- Fix #17: Update root marketplace.json to use skills array

- Fix #17: Convert requirements-clarity to correct plugin directory format

- Fix #17: Convert requirements-clarity to correct plugin directory format

- Convert requirements-clarity to plugin format with English prompts

- Translate requirements-clarity skill to English for plugin compatibility

- Add requirements-clarity Claude Skill

- Add requirements clarification command

- update

## [3.5] - 2025-10-20


### 💼 Other


- Merge pull request #15 from stellarlinkco/swe-agent/13-1760944712

- Fix #13: Clean up redundant README files

- Optimize README structure - Solution A (modular)

- Merge pull request #14 from stellarlinkco/swe-agent/12-1760944588

- Fix #12: Update Makefile install paths for new directory structure

## [3.4] - 2025-10-20


### 💼 Other


- Merge pull request #11 from stellarlinkco/swe-agent/10-1760752533

- Fix marketplace metadata references

- Fix plugin configuration: rename to marketplace.json and update repository URLs

- Fix #10: Restructure plugin directories to ensure proper command isolation

## [3.3] - 2025-10-15


### 💼 Other


- Update README-zh.md

- Update README.md

- Update marketplace.json

- Update Chinese README with v3.2 plugin system documentation

- Update README with v3.2 plugin system documentation

## [3.2] - 2025-10-10


### 💼 Other


- Add Claude Code plugin system support

- update readme

- Add Makefile for quick deployment and update READMEs

## [3.1] - 2025-09-17


### ◀️ Revert


- revert

### 🐛 Bug Fixes


- fixed bmad-orchestrator not fund

- fix bmad

### 💼 Other


- update bmad review with codex support

- 优化 BMAD 工作流和代理配置

- update gpt5

- support bmad output-style

- update bmad user guide

- update bmad readme

- optimize requirements pilot

- add use gpt5 codex

- add bmad pilot

- sync READMEs with actual commands/agents; remove nonexistent commands; enhance requirements-pilot with testing decision gate and options.

- Update Chinese README and requirements-pilot command to align with latest workflow

- update readme

- update agent

- update bugfix sub agents

- Update ask support KISS YAGNI SOLID

- Add comprehensive documentation and multi-agent workflow system

- update commands
<!-- generated by git-cliff -->
