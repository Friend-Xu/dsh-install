# dsh-install workspace

安装管理 DeepSeek Harness 的 MCP 服务器与 skills 的插件工作区。

[![npm](https://img.shields.io/npm/v/@dsh-tools/dsh-install)](https://www.npmjs.com/package/@dsh-tools/dsh-install)
[![GitHub](https://img.shields.io/badge/GitHub-Friend--Xu%2Fdsh--install-blue)](https://github.com/Friend-Xu/dsh-install)

> **使用文档**：[packages/dsh-install/README.md](packages/dsh-install/README.md)
> ——快速上手、命令速查、密钥安全、热重载矩阵、FAQ（真机踩坑全收录）。

| 文档 | 内容 |
|---|---|
| [`packages/dsh-install/README.md`](packages/dsh-install/README.md) | 插件本体（`dsh.bundle` 单包双行：`mcp-registry` 聚合器 + `install-cli` 管理面）与使用文档 |
| [`DESIGN.md`](DESIGN.md) | 设计锚点（存储模型、命令面、聚合器语义、生态摄取、报告矩阵、开发原则、决策记录） |

## 开发

```console
pnpm install
pnpm --dir packages/dsh-install run test        # 136 单元/集成测试（沙箱内可跑）
pnpm --dir packages/dsh-install run typecheck
pnpm --dir packages/dsh-install run build       # tsdown → lib/
pnpm --dir packages/dsh-install exec vitest run --config vitest.e2e.config.mjs
                                                # spawn e2e（本地 fixture + 真实 npx）
```

已在本机真实 harness 验证的链路：`dsh plugin add` → bundle 对账进层栈 →
`mcp add github`（目录简写）→ `mcp list` → `search` → `doctor` →
`skills add` → `mcp import --from mcp-json` → 审计日志落盘；
以及真机全路径（git clone / npx 下载 / stdio 挂载 / URL 市场 / claude 插件
13-skill 提取）。

已知安装注意事项：本地目录 link 安装依赖不进 profile（用 tarball）；
路径含 `&` 会被 `dsh plugin` 的 shell 转发截断（用 npm 包名最省心）。

## 维护者

发布与验证流程（面向维护者，普通用户无需关注）：

- [`docs/publish.md`](docs/publish.md) —— npm 发布指南
- [`docs/verify-checklist.md`](docs/verify-checklist.md) —— 发布前真机验证清单
- [`scripts/verify-run.ps1`](scripts/verify-run.ps1) —— 真机验证一键脚本
- [`docs/launcher-alias.md`](docs/launcher-alias.md) —— 可选的 harness launcher 别名改动说明
