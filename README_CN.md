# Claude Code 多智能体工作流系统

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Claude Code](https://img.shields.io/badge/Claude-Code-blue)](https://claude.ai/code)
[![Version](https://img.shields.io/badge/Version-6.x-green)](https://github.com/miraserver/myclaude)

> 本项目是 [stellarlinkco/myclaude](https://github.com/stellarlinkco/myclaude) 的分支，更新了默认模型（claude-opus-5-5 / claude-sonnet-5-5 / gpt-6.1-sol），修复了 `do` 的 Stop/验证关卡，并实现了幂等的钩子安装。与原项目一样，采用 AGPL-3.0 许可证。

> AI 驱动的开发自动化 - 多后端执行架构 (Codex/Claude/Gemini/OpenCode)

## 快速开始

```bash
npx github:miraserver/myclaude
```

## 前置条件

- Node.js 18 或更高版本
- Python 3（Windows 使用 `py` 启动器或 `python`）
- Git
- Windows 用户：运行 `sparv` 等基于 `.sh` 的技能需要 Git Bash
- 按模块安装并登录所需的后端 CLI：

| 模块 | 后端 CLI |
|------|----------|
| `do` | Codex + Claude |
| `omo` | Codex + Claude + Gemini |
| `course` / `dev` | Codex |
| 其他模块 | 无 |

以上要求依据 [`config.json`](config.json) 中的 agents 和 backends；配置变化时请同步更新此表。

## 模块概览

| 模块 | 描述 | 文档 |
|------|------|------|
| [do](skills/do/README.md) | **推荐** - 5 阶段功能开发 + codeagent 编排 | `/do` 命令 |
| [omo](skills/omo/README.md) | 多智能体编排 + 智能路由 | `/omo` 命令 |
| [bmad](agents/bmad/README.md) | BMAD 敏捷工作流 + 6 个专业智能体 | `/bmad-pilot` 命令 |
| [requirements](agents/requirements/README.md) | 轻量级需求到代码流水线 | `/requirements-pilot` 命令 |
| [essentials](agents/development-essentials/README.md) | 11 个核心开发命令：ask、bugfix、code、debug、docs、enhance-prompt、optimize、refactor、review、test、think | `/code`, `/debug` 等 |
| [sparv](skills/sparv/README.md) | SPARV 工作流 (Specify→Plan→Act→Review→Vault) | `/sparv` 命令 |
| [harness](skills/harness/SKILL.md) | 跨会话自主智能体，支持进度检查点、失败恢复、任务依赖和完成后自我反思 | `/harness` 命令 |
| course | 课程开发（组合 dev + product-requirements + test-cases） | 组合模块 |
| claudekit | 仅安装危险命令防护钩子（pre-bash）；do 是独立模块| 组合模块 |

### 可用技能

可通过 `npx github:miraserver/myclaude --list` 单独安装技能（模块内置技能如 do、omo、sparv 见上表）：

| 技能 | 描述 |
|------|------|
| browser | 浏览器自动化测试和数据提取 |
| codeagent | codeagent-wrapper 多后端 AI 代码任务调用 |
| dev | 轻量级端到端开发工作流 |
| product-requirements | 交互式 PRD 生成（含质量评分）|
| prototype-prompt-generator | 结构化 UI/UX 原型提示词生成 |
| skill-install | 从 GitHub 安装技能（含安全扫描）|
| test-cases | 从需求生成全面测试用例 |

## 核心架构

| 角色 | 智能体 | 职责 |
|------|-------|------|
| **编排者** | Claude Code | 规划、上下文收集、验证 |
| **执行者** | codeagent-wrapper | 代码编辑、测试执行（Codex/Claude/Gemini/OpenCode 后端）|

## 工作流详解

### do 工作流（推荐）

5 阶段功能开发，通过 codeagent-wrapper 编排多个智能体。**大多数功能开发任务的首选工作流。**

```bash
/do "添加用户登录功能"
```

**5 阶段：**
| 阶段 | 名称 | 目标 |
|------|------|------|
| 1 | Understand | 并行探索理解需求和映射代码库 |
| 2 | Clarify | 解决阻塞性歧义（条件触发）|
| 3 | Design | 产出最小变更实现方案 |
| 4 | Implement + Review | 构建功能并审查 |
| 5 | Complete | 记录构建结果 |

**智能体：**
- `code-explorer` - 代码追踪、架构映射
- `code-architect` - 设计方案、文件规划
- `code-reviewer` - 代码审查、简化建议
- `develop` - 实现代码、运行测试

---

### OmO 多智能体编排器

基于风险信号智能路由任务到专业智能体。

```bash
/omo "分析并修复这个认证 bug"
```

**智能体层级：**
| 智能体 | 角色 | 后端 |
|-------|------|------|
| `oracle` | 技术顾问 | Claude |
| `librarian` | 外部研究 | Codex |
| `explore` | 代码库搜索 | Claude |
| `develop` | 代码实现 | Codex |
| `frontend-ui-ux-engineer` | UI/UX 专家 | Claude |
| `document-writer` | 文档撰写 | Gemini |

**常用配方：**
- 解释代码：`explore`
- 位置已知的小修复：直接 `develop`
- Bug 修复（位置未知）：`explore → develop`
- 跨模块重构：`explore → oracle → develop`

---

### SPARV 工作流

极简 5 阶段工作流：Specify → Plan → Act → Review → Vault。

```bash
/sparv "实现订单导出功能"
```

**核心规则：**
- **10 分规格门**：得分 0-10，必须 >=9 才能进入 Plan
- **2 动作保存**：每 2 次工具调用写入 journal.md
- **3 失败协议**：连续 3 次失败后停止并上报
- **EHRB**：高风险操作需明确确认

**评分维度（各 0-2 分）：**
1. Value - 为什么做，可验证的收益
2. Scope - MVP + 不在范围内的内容
3. Acceptance - 可测试的验收标准
4. Boundaries - 错误/性能/兼容/安全边界
5. Risk - EHRB/依赖/未知 + 处理方式

---

### BMAD 敏捷工作流

完整企业敏捷方法论 + 6 个专业智能体。

```bash
/bmad-pilot "构建电商结账系统"
```

**智能体角色：**
| 智能体 | 职责 |
|-------|------|
| Product Owner | 需求与用户故事 |
| Architect | 系统设计与技术决策 |
| Scrum Master | Sprint 规划与任务分解 |
| Developer | 实现 |
| Code Reviewer | 质量保证 |
| QA Engineer | 测试与验证 |

**审批门：**
- PRD 完成后（90+ 分）需用户审批
- 架构完成后（90+ 分）需用户审批

---

### 需求驱动工作流

轻量级需求到代码流水线。

```bash
/requirements-pilot "实现 API 限流"
```

**100 分质量评分：**
- 功能清晰度：30 分
- 技术具体性：25 分
- 实现完整性：25 分
- 业务上下文：20 分

---

### 开发基础命令

日常编码任务的直接命令。

| 命令 | 用途 |
|------|------|
| `/code` | 实现功能 |
| `/debug` | 调试问题 |
| `/test` | 编写测试 |
| `/review` | 代码审查 |
| `/optimize` | 性能优化 |
| `/refactor` | 代码重构 |
| `/docs` | 编写文档 |
| `/ask` | 提问和咨询 |
| `/bugfix` | Bug 修复 |
| `/enhance-prompt` | 提示词优化 |
| `/think` | 深度思考分析 |

---

## 安装

npx 安装器（[`bin/cli.js`](bin/cli.js)）是受支持的安装方式。`install.py` 为兼容性保留的旧版安装器，功能可能滞后。

```bash
# 交互式安装器（推荐）
npx github:miraserver/myclaude

# 列出可安装项（module:* / skill:* / codeagent-wrapper）
npx github:miraserver/myclaude --list

# 将已安装模块和独立技能更新到最新发布版本
npx github:miraserver/myclaude --update

# 指定安装目录 / 强制覆盖
npx github:miraserver/myclaude --install-dir ~/.claude --force
```

`--update` 会检测目标安装目录（默认 `~/.claude`，通过 `installed_modules.json` 跟踪）中已安装的模块和独立技能，并更新到最新发布版本。以 `skill:<name>` 选择的独立技能现在与模块一样，支持安装记录跟踪、更新和卸载。

默认不再安装全局 `CLAUDE.md`。使用 `--with-claude-md` 显式启用；已有的 `CLAUDE.md` 永远不会被覆盖：

```bash
npx github:miraserver/myclaude --with-claude-md
```

### 版本与发布

发布版本使用 [github.com/miraserver/myclaude](https://github.com/miraserver/myclaude/releases) 上的 `vX.Y.Z` 标签。使用 `--tag vX.Y.Z` 选择发布内容（模块和 `codeagent-wrapper`），例如 `npx github:miraserver/myclaude --tag vX.Y.Z` 可安装或回退到该发布版本。不指定 `--tag` 时使用最新发布版本。仓库地址后的 `#ref` 仅选择 npx 运行的安装器代码；使用 `--update` 将已安装模块更新到最新发布版本。

发布资产包含 `SHA256SUMS`，`install.sh`、`install.bat` 和 npx 安装器会用它校验下载文件。

### 模块配置

通过交互式菜单选择要安装的模块；修改本地 `config.json` 不会配置 npx 安装。使用 `--module` 指定要更新或卸载的模块：

```bash
npx github:miraserver/myclaude
npx github:miraserver/myclaude --update --module do,omo
npx github:miraserver/myclaude uninstall --module omo
```

## 工作流选择指南

| 场景 | 推荐 |
|------|------|
| 功能开发（默认） | `/do` |
| Bug 调查 + 修复 | `/omo` |
| 大型企业项目 | `/bmad-pilot` |
| 快速原型 | `/requirements-pilot` |
| 简单任务 | `/code`, `/debug` |

## 后端 CLI 要求

| 后端 | 必需功能 |
|------|----------|
| Codex | `codex e`, `--json`, `-C`, `resume` |
| Claude | `--output-format stream-json`, `-r` |
| Gemini | `-o stream-json`, `-y`, `-r` |
| OpenCode | `opencode`, stdin 模式 |

## 故障排查

**Codex wrapper 未找到：**
```bash
# 选择：codeagent-wrapper
npx github:miraserver/myclaude
```

**模块未加载：**
```bash
cat ~/.claude/installed_modules.json
npx github:miraserver/myclaude --force
```

## FAQ

| 问题 | 解决方案 |
|------|----------|
| "Unknown event format" | 日志显示问题，可忽略 |
| Gemini 无法读取 .gitignore 文件 | 从 .gitignore 移除或使用其他后端 |
| Codex 权限拒绝 | 在 ~/.codex/config.toml 设置 `approval_policy = "never"` |

更多问题请访问 [GitHub Issues](https://github.com/miraserver/myclaude/issues)。

## 安全模型

嵌套的 Claude、Codex、Gemini 后端默认跳过权限提示或沙箱保护。要恢复 Claude 的权限提示，请设置 `CODEAGENT_SKIP_PERMISSIONS=false`；要关闭 Codex 的沙箱绕过，请设置 `CODEX_BYPASS_SANDBOX=false`。这些显式为 false 的环境变量值会覆盖预设的 `yolo`；Claude 的显式 CLI 参数或任务级权限设置优先于环境变量。Gemini 包装器始终添加 `-y`，目前没有关闭开关；需要权限提示或沙箱时，请直接运行 Gemini CLI，省略 `-y` 并启用沙箱。

Harness 钩子仅在通过 harness 技能激活并登记到 `~/.claude/harness-state` 的项目中生效。`do` 的 Stop 钩子仅验证本机通过 `/do` 创建的任务。安装器使用发布资产 `SHA256SUMS` 校验下载文件的 SHA-256。

## 安装后的路径

Unix 上包装器默认位于 `~/.claude/bin/codeagent-wrapper`；Windows 上位于 `%USERPROFILE%\bin\codeagent-wrapper.exe`，不在 `~/.claude/bin`。

## 许可证

AGPL-3.0 - 查看 [LICENSE](LICENSE)

### 商业授权

如需商业授权（无需遵守 AGPL 义务），请联系：support@stellarlink.co

## 支持

- [GitHub Issues](https://github.com/miraserver/myclaude/issues)
