# dsh-install workspace

安装管理 DeepSeek Harness 的 **MCP 服务器**与 **skills** 的插件。

[![npm](https://img.shields.io/npm/v/@dsh-tools/dsh-install)](https://www.npmjs.com/package/@dsh-tools/dsh-install)
[![GitHub](https://img.shields.io/badge/GitHub-Friend--Xu%2Fdsh--install-blue)](https://github.com/Friend-Xu/dsh-install)

---

## 怎么用：安装一个 MCP 服务器（完整示范）

```powershell
# 1. 安装插件（一次，两个 profile 各装一份）
dsh plugin --profile install add @dsh-tools/dsh-install   # CLI 命令住这里
dsh plugin --profile web add @dsh-tools/dsh-install       # 服务器在这里被挂载

# 2. 启用挂载行（一次手工配置）：记事本打开
#    <DSH_HOME>\profiles\web\cordis.patch.yml，把 [] 改成：
#    - id: mcp-registry
#      disabled: false

# 3. 重启一次 web（装新插件包必须重启一次；此后一切改动免重启）
dsh web

# 4. 安装 MCP 服务器（示例三种装法）
dsh --profile install mcp add github                       # 内置目录，不用记 npx 命令
dsh --profile install mcp add zai -e ZAI_API_KEY -- npx -y @z_ai/mcp-server   # 任意包
dsh --profile install mcp add myapi --transport http --url https://host/mcp   # HTTP

# 5. 查看与诊断
dsh --profile install mcp list          # 列出已装服务器
dsh --profile install mcp doctor zai    # 诊断运行时/环境变量/端点
```

完成后：模型新会话里直接出现 `mcp__github__*`、`mcp__zai__*` 等工具；
web 输入框敲 `/` 有 `/mcp`、`/skills` 斜杠命令。

## 安装一个 skill（完整示范）

```powershell
dsh --profile install skills add github:anthropics/skills#skills/docx   # git 源
dsh --profile install skills add .\my-skill                             # 本地目录
dsh --profile install skills list
```

装进 `~/.dsh/skills` 后 harness 自动发现，**免重启**即可用。

## 其他常用命令

```powershell
dsh --profile install mcp on zai | off zai | remove zai
dsh --profile install mcp import --from claude|codex|mcp-json   # 迁移别的 agent 的配置
dsh --profile install search git                                 # 搜内置+市场目录
dsh --profile install uninstall --dry-run                        # 整体卸载预览
```

## 文档

| 文档 | 内容 |
|---|---|
| [`packages/dsh-install/README.md`](packages/dsh-install/README.md) | **完整使用文档**：命令速查、密钥安全、热重载矩阵、FAQ |
| [`DESIGN.md`](DESIGN.md) | 设计锚点（存储模型、聚合器语义、生态摄取、报告矩阵、决策记录） |

## 项目本体怎么装

### 方式一：npm 包（日常使用，推荐）

```powershell
dsh plugin --profile install add @dsh-tools/dsh-install
dsh plugin --profile web add @dsh-tools/dsh-install
```

### 方式二：从源码构建安装（开发/试用未发布版本）

```powershell
git clone https://github.com/Friend-Xu/dsh-install.git
cd dsh-install
pnpm install
pnpm --dir packages/dsh-install run test        # 跑测试确认源码健康
pnpm --dir packages/dsh-install run build       # tsdown → lib/
pnpm --dir packages/dsh-install pack --pack-destination .\.local\dist
# 产出 .\.local\dist\dsh-tools-dsh-install-0.1.0.tgz

# 安装（注意：用 tarball 而不是目录；绝对路径里不要含 & 等 shell 特殊字符）
dsh plugin --profile install add D:\...\dsh-install\.local\dist\dsh-tools-dsh-install-0.1.0.tgz
dsh plugin --profile web add D:\...\dsh-install\.local\dist\dsh-tools-dsh-install-0.1.0.tgz
```

装完后续步骤与方式一完全相同（启用 `mcp-registry` 行 → 重启一次 web → `mcp add`）。

## 开发

```console
pnpm --dir packages/dsh-install run test        # 136 单元/集成测试（沙箱内可跑）
pnpm --dir packages/dsh-install run typecheck
pnpm --dir packages/dsh-install exec vitest run --config vitest.e2e.config.mjs
                                                # spawn e2e（本地 fixture + 真实 npx）
```

已知安装注意事项：本地目录 link 安装依赖不进 profile（用 tarball）；
路径含 `&` 会被 `dsh plugin` 的 shell 转发截断（用 npm 包名最省心）。

## 维护者

发布与验证流程（普通用户无需关注）：

- [`docs/publish.md`](docs/publish.md) —— npm 发布指南
- [`docs/verify-checklist.md`](docs/verify-checklist.md) —— 发布前真机验证清单
- [`scripts/verify-run.ps1`](scripts/verify-run.ps1) —— 真机验证一键脚本
- [`docs/launcher-alias.md`](docs/launcher-alias.md) —— 可选的 harness launcher 别名改动说明
