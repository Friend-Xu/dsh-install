# dsh-install workspace

安装管理 DeepSeek Harness 的 MCP 服务器与 skills 的插件工作区。

[![npm](https://img.shields.io/npm/v/@dsh-tools/dsh-install)](https://www.npmjs.com/package/@dsh-tools/dsh-install)
[![GitHub](https://img.shields.io/badge/GitHub-Friend--Xu%2Fdsh--install-blue)](https://github.com/Friend-Xu/dsh-install)

| 路径 | 内容 |
|---|---|
| [`packages/dsh-install`](packages/dsh-install/README.md) | 插件本体（`dsh.bundle` 单包双行：`mcp-registry` 聚合器 + `install-cli` 管理面） |
| [`DESIGN.md`](DESIGN.md) | 设计锚点（存储模型、命令面、聚合器语义、生态摄取、报告矩阵、决策记录） |
| [`docs/launcher-alias.md`](docs/launcher-alias.md) | 可选的 harness launcher 别名改动说明 |

## 快速开始

```console
pnpm install
pnpm --dir packages/dsh-install test        # 126 测试（沙箱内可跑）
pnpm --dir packages/dsh-install typecheck
pnpm --dir packages/dsh-install build       # tsdown → lib/

# 真机安装（本地 tarball 或发布后的包名）
pnpm --dir packages/dsh-install pack
dsh plugin --profile install add ./packages/dsh-install/dsh-install-0.1.0.tgz
dsh --profile install mcp add github
```

已在本机真实 harness（源码 checkout 的 `apps/cli/lib/bin.js` + 独立
`DSH_HOME`）验证的链路：`dsh plugin add` → bundle 对账进层栈 →
`mcp add github`（目录简写）→ `mcp list` → `search` → `doctor` →
`skills add` → `mcp import --from mcp-json` → 审计日志落盘。

## 已知安装注意事项

- **本地目录用 link 安装时**，链接包的依赖从链接的真实路径解析，不会装进
  profile —— 本地验证请用 `pnpm pack` 出的 tarball（与 npm 发布路径一致）。
- 路径含 `&` 等 shell 元字符的 spec 会被 `dsh plugin` 的 shell 转发截断
  （harness 侧 `spawnSync(..., shell: true)` 行为），建议把包放在无特殊字符
  的路径再安装。
