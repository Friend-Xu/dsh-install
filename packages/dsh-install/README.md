# dsh-install

> Install and manage **MCP servers** and **skills** for the DeepSeek Harness.
> 注册表驱动的安装管理插件：CLI + 斜杠命令 + 热挂载聚合器 + 生态导入 + 卸载 + 逐条裁决审计。

[![npm](https://img.shields.io/npm/v/@dsh-tools/dsh-install)](https://www.npmjs.com/package/@dsh-tools/dsh-install)
[![GitHub](https://img.shields.io/badge/GitHub-Friend--Xu%2Fdsh--install-blue)](https://github.com/Friend-Xu/dsh-install)

---

## 快速上手（5 分钟）

### 1. 安装插件包（一次性，每个 profile 各装一次）

```powershell
dsh plugin --profile install add @dsh-tools/dsh-install   # 管理面（CLI 命令住这里）
dsh plugin --profile web add @dsh-tools/dsh-install       # 消费面（挂载服务器、斜杠命令）
```

> 首次会初始化 `install` profile 并下载 dsh-base（数百 MB，属正常）。
> 输出里的 `[WARN] Issues with peer dependencies found` 是**设计预期**：
> 本插件把 cordis 等声明为 peerDependencies，让 pnpm 不安装、复用 harness
> 自带的那份（零重复、零版本漂移），警告可无视。

### 2. 启用聚合器行（一次手工配置）

用记事本打开 `<DSH_HOME>\profiles\web\cordis.patch.yml`（默认
`C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml`），把空列表 `[]` 改为：

```yaml
- id: mcp-registry
  disabled: false
```

保存。默认禁用是刻意设计：装插件不应静默拉起子进程（与 harness 自带
skill-badge 行的先例一致），启用必须显式。

### 3. 重启一次 web（只此一次）

```powershell
dsh web
```

**为什么必须重启这一次**：`dsh plugin add` 把插件的两行加进了 bundle 层，
而 bundle 层只在 boot 时读入——运行中的旧进程看不到它们。这次重启之后，
**一切改动全部免重启**（见下方热重载矩阵）。

### 4. 验证

```powershell
dsh --profile install mcp add everything          # 官方测试服务器，无需密钥
dsh --profile install mcp list                    # 应列出 everything
dsh --profile install mcp doctor everything       # 诊断运行时/环境变量
```

web 里：输入框敲 `/`，斜杠菜单应出现 `/mcp`、`/skills`；模型新会话中可见
`mcp__everything__*` 工具。

---

## 命令速查

### mcp

```powershell
dsh --profile install mcp add github                                   # 内置目录简写
dsh --profile install mcp add uvx:mcp-server-git                        # URI 简写（派生名字）
dsh --profile install mcp add zai -- npx -y @z_ai/mcp-server            # 任意服务器（-- 形式）
dsh --profile install mcp add myapi --transport http --url <url>        # HTTP 服务器
dsh --profile install mcp list [--format json] | get <n> | remove <n> [--all] [--dry-run]
dsh --profile install mcp on <n> | off <n> | update <n> ... | doctor <n>
dsh --profile install mcp import --from claude|codex|mcp-json|claude-plugin|auto [--path <p>]
```

**语法红线**：
- `--` 是分界线：之后的内容**原样**成为启动命令；`-e` 等选项必须放 `--` 之前；
- 装了密钥就别带进 `--` 后面（会把明文写进启动参数，见 FAQ）。

### skills

```powershell
dsh --profile install skills add ./my-skill
dsh --profile install skills add github:owner/repo#subdir@v1.0
dsh --profile install skills add <path> --link                        # 符号链接（开发模式）
dsh --profile install skills list | remove <n> [--all] [--dry-run] | update <n> <src>
```

落位即生效：装进 `~/.dsh/skills` 或 `<project>/.dsh/skills`，harness 的
skill 提供方自动发现，免重启。

### 其他

```powershell
dsh --profile install search <query>                                  # 内置 + 市场目录
dsh --profile install marketplace add|list|remove|sync                 # 市场协议端
dsh --profile install plugin install <name>@<marketplace> [--extract-content]
dsh --profile install uninstall [--dry-run] [--purge-log]              # 整体卸载
```

---

## 密钥安全（重要）

- 注册表**永不存明文密钥**：`-e ZAI_API_KEY` 存入的是 `${ZAI_API_KEY}`
  引用，挂载时才从环境变量展开；
- 正确姿势：`mcp add zai -e ZAI_API_KEY -- npx -y <包>`（`-e` 在 `--` 前）；
- 密钥只在环境变量里（`setx ZAI_API_KEY "..."`，新终端生效）；
- 若不慎把明文写进了启动参数或聊天记录，请**轮换密钥**并 `mcp remove`
  后重装。查看实际存储：`mcp get <n>`——`env` 字段应是 `${...}` 引用。

## 热重载矩阵

| 改动 | 是否需重启 |
|---|---|
| `dsh plugin add/remove`（装/卸插件包本身） | **需要**（bundle 层只在 boot 读入） |
| 改 patch 启用/停用聚合器行 | **免重启**（harness 的 patch 热重载，保存即生效） |
| `mcp add/remove/on/off` | **免重启**（聚合器监视注册表，差分重挂） |
| `skills add/remove` | **免重启**（skill 提供方自带 watcher） |

## 存储与文件

```
<DSH_HOME>/mcp.json                # user scope 注册表（密钥只存 ${VAR} 引用）
<project>/.dsh/mcp.json            # project scope（git 可共享，同名覆盖 user）
<DSH_HOME>/skills-manifest.json    # skill 来源追踪（remove 只删自己装过的）
<DSH_HOME>/marketplaces.json       # 市场注册
<DSH_HOME>/logs/install.jsonl      # 审计日志（每次操作逐条裁决，可重放）
<DSH_HOME>/install/work/           # 克隆过客区（每次 git 克隆前重置，用完即清）
<DSH_HOME>/install/leftover/       # 未迁移载荷的存档（uninstall 清）
```

插件代码在 profile 内（`<DSH_HOME>/profiles/<name>/node_modules/`），与数据分离。

## 常见问题（FAQ）

**Q：`[WARN] Issues with peer dependencies found` 要紧吗？**
不要紧。本插件故意把 cordis/dsh-mcp-client 等声明为 peer，复用 harness
安装自身的那份，避免版本漂移。

**Q：`dsh plugin add <本地路径>` 为什么有问题？**
给目录路径是 link 安装，依赖不装进 profile；请用 `pnpm pack` 出的
tarball。另外路径含 `&` 等 shell 元字符会被 `dsh plugin` 的 shell 转发
截断（harness 侧行为）——用包名最省心。

**Q：迁移过 `DSH_HOME`（如 C→D 跨盘复制）后 dsh 启动报错？**
跨盘复制会把 `profiles/node_modules` 里的 junction（目录链接）解引用成
普通目录，harness 启动时检测报错。解法：把该目录改名（如
`node_modules.bak`），harness 会自愈重建全部链接；确认正常后删除 .bak。
用 robocopy 迁移时加 `/XJ` 可避免。

**Q：`mcp add` 后模型看不到工具？**
三查：① 聚合器行是否已启用（patch 文件）；② 装完插件包后是否**重启过一次**
web（bundle 层 boot 才读入）；③ `mcp doctor <n>` 看运行时/环境变量诊断。

## 卸载

```powershell
dsh --profile install uninstall [--dry-run] [--purge-log]   # 清数据面，日志默认保留
dsh plugin --profile <name> remove @dsh-tools/dsh-install   # 卸包本体，每个 profile 一次
```

## 开发

```powershell
pnpm --dir packages/dsh-install run test        # 136 单元/集成测试
pnpm --dir packages/dsh-install run build       # tsdown → lib/
pnpm --dir packages/dsh-install pack            # 打包验证
pnpm --dir packages/dsh-install exec vitest run --config vitest.e2e.config.mjs
                                                # spawn e2e（真机环境）
```

发布流程见 [docs/publish.md](../docs/publish.md)，真机验证见
[docs/verify-checklist.md](../docs/verify-checklist.md)。

## License

MIT
