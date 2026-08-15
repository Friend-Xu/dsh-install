# dsh-install 设计文档

> MCP 服务器与 skill 的安装管理插件（外部 `dsh.bundle` 包）。本文件是设计的唯一锚点，
> 与对话结论一致；实现如偏离，先改这里。

## 1. 目标与非目标

**目标**：给 DeepSeek Harness 补上 Claude Code / Codex / CC Switch 式的安装管理面——
装 MCP 服务器、装 skills、吃 claude/codex/市场生态，运行时热挂载，全程可审计。

**非目标**（本期明确不做）：
- provider/模型切换（CC Switch 的另一半功能）
- Web 富 GUI（设置卡片/弹窗表单）：外部 bundle 无法进入 client roster，属 harness 侧改动
- DSH 无对应运行时的 claude 插件载荷（commands/agents/hooks 代码层）：只报告，不搬运

## 2. 架构总览

一个 npm 包 `@dsh-tools/dsh-install`，声明 `dsh.bundle`。核心逻辑一层，适配器两个：

```
src/
  registry/    注册表核心：路径、schema、合并、原子写、env 引用（零 cordis 依赖）
  ops/         领域操作：mcp/skills/import/marketplace + 报告审计（零 cordis 依赖）
  index.ts     mcp-registry 行：聚合器（读注册表 → ctx.plugin 挂 mcp-client 子实例 → watch 差分重挂）
  cli.ts       install-cli 行：cmdline 适配器（专用 install profile）+ 斜杠命令适配器（ctx.commands）
```

**cordis.patch.yml 两行**：
- `mcp-registry`：默认 `disabled: true`（装插件不静默起子进程；与 skill-badge 先例一致），
  在消费 profile 的 cordis.patch.yml 中启用。
- `install-cli`：常开但静默——仅当 `ctx.cmdlineArgs` 首参为 `mcp|skills|marketplace|plugin|search`
  时解析；斜杠命令注册在 `ctx.commands` 上（宿主级，web/TUI 通吃）。

## 3. 存储模型

```
$DSH_HOME/mcp.json                # user scope（默认）
<project>/.dsh/mcp.json           # project scope（可入 git；同名覆盖 user）
$DSH_HOME/skills-manifest.json    # skill 安装清单（name → source/ref/落点/时间）
$DSH_HOME/marketplaces.json       # 市场注册表（name → source/ref/sync 元数据）
$DSH_HOME/plugins-manifest.json   # 插件来源清单（(profile,包名) → 市场/版本/装于）
$DSH_HOME/logs/install.jsonl      # 审计日志：每次操作的逐条裁决
```

mcp.json 条目：`transport: stdio|streamable-http` + mcp-client 的 config 超集 +
`enabled`（false 不挂载）+ `origin`（来源/时间）。**secret 只存 `${ENV_NAME}` 全串模板**，
绝不落明文；聚合器挂载前展开。项目根 = 最近 `.git` 祖先（与 skill 提供方同规则）。

## 4. 命令面

```
# CLI（专用 install profile：树内只有 base+本包，CLI 是唯一解析者）
dsh --profile install mcp add <name> -- <command> [args] [-e KEY=ENV] [--transport http <url>]
dsh --profile install mcp add <name>            # 市场/内置目录解析（npx:/uvx:/docker:/https:/./path）
dsh --profile install mcp list|get|remove|on|off|update|doctor|import|export
dsh --profile install skills add|list|remove|update
dsh --profile install marketplace add|list|remove|sync
dsh --profile install plugin install [--extract-content] [--profile <p>]
dsh --profile install search <query>

# 斜杠命令（web/TUI，宿主级注册，直接渲染 CommandResult，不进模型历史）
/mcp /mcp add /mcp remove /mcp on /mcp off
/skills /skills add /skills remove
```

运行时矩阵：`npx:`（npm 包）、`uvx:`（python）、`docker:`、`https://`（Streamable HTTP）、
本地路径（探测 package.json bin / python 入口拼 stdio 命令）。URI 简写安装时
**派生合法注册名**（`uvx:mcp-server-git` → `mcp-server-git`）。

实现备注（与早期草案的差异，均已在代码中落地）：
- `mcp import --from claude|codex|mcp-json|claude-plugin|auto` 承载导入器（挂在 mcp 下）；
- `mcp export` 尚未实现（审计日志 + 注册表 JSON 本身即可导出），留作后续；
- commander 不等待 async action → `runManagement` 为 async，异步动作进 pending 队列，
  斜杠处理器 await 之、CLI apply 不 await（exit 回调在动作结束时触发）。

## 5. 生态摄取

- **导入器**：`.mcp.json`（Cursor/VS Code/Smithery 产物）、`~/.claude.json`、
  `~/.codex/config.toml` 的 mcp_servers；claude-plugin（npm 包/市场条目）按载荷分类摄取。
- **skill 来源**：本地路径（`--link` 符号链接）、git URL（子目录 + ref pin）、tarball、
  marketplace 条目；集合仓库交互选择或 `--all`。Claude Code 的 SKILL.md 格式兼容
  （多余 frontmatter 字段进 metadata）。
- **市场**：`marketplace add <name> <git|path|json-url>`；双形状兼容
  `.claude-plugin/marketplace.json` 与 DSH 原生目录 schema；条目按 kind 映射安装路径
  （mcpServers → 注册表；skills → 文件；dshPlugins → 转发 dsh plugin add；
  claude plugin 包 → `--extract-content` 内容层降级）。
- **代码层不假装兼容**：commands/agents/hooks 按 INCOMPATIBLE_* 报告，
  原文存档 `.dsh/install/leftover/` 绝不销毁。

## 6. 安装报告（一等公民）

每次变更操作产出逐条裁决：✅ 导入 / ⚠️ 部分 / ❌ 未迁移 / 🚫 失败，
每项带稳定原因码 + 一句话解释 + 可执行建议。三个出口：CLI 人读渲染
（`--format json`/`--quiet`）、斜杠命令直接渲染、`$DSH_HOME/logs/install.jsonl`
审计存档（`report <id>` 可重放）。

原因码矩阵（稳定、可 grep）：
`INCOMPATIBLE_COMMANDS` `INCOMPATIBLE_AGENTS` `INCOMPATIBLE_HOOKS`
`SKIP_UNSUPPORTED_FIELD` `SECRET_CONVERTED` `ENV_UNRESOLVED` `RUNTIME_MISSING`
`CONFLICT_EXISTING` `DUPLICATE_SERVER` `NOT_FOUND` `INVALID_NAME` `INVALID_ENTRY`。

## 7. 运行时：聚合器语义

- boot 时读 user+project 注册表 → enabled 条目 `ctx.plugin(McpClient, 展开配置)` 挂子实例。
- 监听两文件变化 → 按 serverName 差分：不变保留、改 dispose+重建、删 dispose。
- 冲突隔离：子实例激活失败被逐条捕获记录，不影响其余服务器（mcp-client 自带
  serverName 去重 = 与 cordis.yml 手写行撞名时大声失败）。
- 聚合器行由 profile 的 cordis.patch.yml 显式启用；管理命令经斜杠通道在同一
  web 进程内写文件 → watcher 热重挂，零重启。

## 8. 依赖与安装

```
dsh plugin --profile web add @dsh-tools/dsh-install      # 消费 profile（启用 mcp-registry 行）
dsh plugin --profile install add @dsh-tools/dsh-install  # 专用管理 profile
```

- **peerDependencies**（回落到 harness 安装自身 node_modules，零漂移零重复）：
  `@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-cmdline ^0.1.0-rc.5`、
  `@deepseek-ai/dsh-commands ^0.1.0-rc.5`、`@deepseek-ai/dsh-mcp-client ^0.1.0-rc.5`、
  `@deepseek-ai/schemastery ^3.18.1`。
- **dependencies**：`@deepseek-ai/dsh-home-paths ^0.1.0-rc.5`（纯工具，官方设计
  即"不依赖 harness 以便产品包共享路径约定"——保证与 skill 提供方扫描同一根）、
  `commander ^15`（CLI 解析）。

真机验证结论（2026-08，harness 0.1.0-rc.5 源码 checkout + 独立 DSH_HOME）：
tarball 安装全链路通过（`dsh plugin add <tgz>` → 对账 → boot → CLI 全命令）。
目录 link 安装（`add <dir>`）下依赖从链接真实路径解析、不会装进 profile——
本地验证一律走 `pnpm pack`；spec 路径含 `&` 等 shell 元字符会被 `dsh plugin`
的 shell 转发截断，属 harness 侧已知行为。

## 9. 里程碑

- **M1** ✅ 骨架 + 注册表核心（paths/model/store/envref）+ mcp 操作 + 报告审计 + 单测
- **M2** ✅ 聚合器（投影/差分重挂/env 展开/冲突隔离/串行 sync）+ 真实 MCP 协议 e2e（进程内 Streamable HTTP）
- **M3** ✅ install-cli 行（cmdline + 斜杠命令适配器）+ skills 安装器（本地/git 规范、copy/--link、manifest）
- **M4** ✅ 生态摄取：运行时矩阵 + 内置目录 + search + 三生态导入器 + 市场 + claude-plugin 内容导入 + doctor + plugin install
- **M5** 🔄 README + 文档同步 + `dsh plugin add` 真机安装验证（stdio/git spawn 路径如实标注）+ 可选 launcher 别名说明

## 10. 开发原则（用户设定，所有编码必须遵循）

1. **高内聚**：一个模块/文件职责单一，相关逻辑聚合在所属模块内。
2. **低耦合**：模块间通过稳定接口交互，不互相渗透实现细节。
3. **单向依赖**：适配器（行插件/斜杠）→ 引擎 → 领域 ops → 数据层 → util/常量；
   禁止反向依赖与循环依赖。
4. **禁止兜底**：不为不可能发生的场景写 fallback；信任内部契约，仅在系统边界
   （用户输入、外部 API、文件系统、子进程）做校验与失败处理。
5. **环境隔离**：所有运行时与依赖安装在项目根内（本仓库：node_modules 与
   `.pnpm-store` 均在根内）；禁止全局安装与系统 PATH 修改。插件运行时不安装
   任何外部运行时（npx/uvx/docker 只探测、不安装）。
6. **产物隔离**：所有开发/验证产物存放于项目根内（docs/、`.local/`）；测试的
   运行时临时文件属引擎内部豁免（用完即清）。验证时一律用根内
   `.local/verify-home` 作为 DSH_HOME，绝不触碰真实 `~/.dsh`。

2026-08 合规审计整改记录：
- 消除 `cli.ts ↔ slash.ts` 循环依赖：抽出 `management.ts` 引擎层，
  两适配器同向依赖引擎（原则 3）。
- `RegistryError` 从 `registry/model.ts` 抽至 `util/errors.ts` 单一真源，
  各域不再跨域借类型（原则 1/2）。
- pnpm store 移入根内 `.pnpm-store`（原则 5）；`.local/` 约定写入 .gitignore（原则 6）。

## 11. 关键决策记录（含否决项）

| 决策 | 结论 | 理由 |
|---|---|---|
| 存储 | 独立注册表文件，不写 cordis.yml | cordis.yml 是组合层不是用户数据；CRUD/启停/导入导出才干净 |
| 管理面 | 专用 install profile（CLI 唯一解析者） | headless 把位置参数当 task 吞掉、web 对位置参数报错，无法共存 |
| 聚合器默认态 | `disabled: true`，显式启用 | 装插件不静默改变行为/起子进程；与 skill-badge 先例一致 |
| 斜杠命令 | 宿主级注册（文本进/出） | 外部 bundle 进不了 client roster，富 GUI 属 harness 侧改动 |
| 包形态 | 单包双行（mcp-registry + install-cli） | CLI 行以 args 首参门控静默，无需拆包即可安全装进任何 profile |
| claude 插件代码层 | 不搬运，报告 + leftover 存档 | DSH 无对应运行时；诚实降级优于假装兼容 |
