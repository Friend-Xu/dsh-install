# 真机验证清单（发布前必跑）

按开发原则 6：所有验证产物在项目根内，`DSH_HOME` 覆盖到根内目录，
绝不触碰真实 `~/.dsh`。验证完毕删除 `.local/verify-home` 即可。

## 准备（一次性）

```powershell
# 1. 构建 + 打包（产物在项目根内 .local/dist）
pnpm --dir packages/dsh-install run build
pnpm --dir packages/dsh-install pack --pack-destination ..\.local\dist

# 2. 根内验证环境
$env:DSH_HOME = '<project-root>\.local\verify-home'
Remove-Item $env:DSH_HOME -Recurse -Force -ErrorAction SilentlyContinue
$tarball = '<project-root>\.local\dist\dsh-install-0.1.0.tgz'

# 3. 装进管理 profile（tarball 安装 = npm 发布后用户的真实安装路径）
node <harness>\apps\cli\lib\bin.js plugin --profile install add $tarball
```

> 注意：`dsh plugin add <目录>` 是 link 安装、依赖不装进 profile——
> 验证必须用 tarball（与 npm 发布路径一致）。spec 路径不要含 `&` 等
> shell 元字符（harness 侧 shell 转发会截断）。

## 三条关键路径

### A. git 源 skill 安装（clone → 落位 → 清理）

```powershell
node <harness>\apps\cli\lib\bin.js --profile install skills add github:modelcontextprotocol/servers#src/...@main
# 换成真实的 skill 仓库，验证：
#   1) 报告显示 installed skill + ref
#   2) $env:DSH_HOME\skills\<name>\SKILL.md 存在
#   3) $env:DSH_HOME\install\work 目录已清空（克隆即清）
```

### B. stdio MCP 真挂载（npx 拉取 + 起进程 + 工具发现）

```powershell
node <harness>\apps\cli\lib\bin.js --profile install mcp add everything
# server-everything 是官方集成测试服务器，无需密钥
node <harness>\apps\cli\lib\bin.js --profile install mcp doctor everything
# 验证 npx 在 PATH；然后在长驻 profile 观察挂载日志：
# 编辑 $env:DSH_HOME\profiles\install\cordis.patch.yml 启用 mcp-registry 行
node <harness>\apps\cli\lib\bin.js --profile install mcp list
# 期望：mcp-registry: mounted everything (stdio, user) 日志 + npx 子进程存活
```

### C. URL 市场 fetch（远程 catalog → search）

```powershell
node <harness>\apps\cli\lib\bin.js --profile install marketplace add test-mkt <真实 catalog URL>
node <harness>\apps\cli\lib\bin.js --profile install marketplace sync test-mkt
node <harness>\apps\cli\lib\bin.js --profile install search <catalog 内的关键词>
# 期望：sync 报告 servers/skills/plugins 计数；search 命中 test-mkt 条目
```

### D. claude 插件 URL 提取（git 克隆 → 拆解 → 即清）

```powershell
node <harness>\apps\cli\lib\bin.js --profile install mcp import --from claude-plugin --path https://github.com/<owner>/<claude-plugin-repo>
# 期望：报告逐条裁决（skills/mcpServers 安装 + INCOMPATIBLE_* 存档），
# leftover 下有 <插件名>/plugin.json，work 目录已清空
```

## 收尾

```powershell
node <harness>\apps\cli\lib\bin.js --profile install uninstall --purge-log
Remove-Item $env:DSH_HOME -Recurse -Force
```

## 判定标准

| 检查点 | 通过标准 |
|---|---|
| git clone | 报告含 ref；work 目录事后为空 |
| stdio 挂载 | mounted 日志 + 子进程存活 + doctor 探测到运行时 |
| URL 市场 | sync 计数正确；search 命中 |
| claude URL 提取 | 三态裁决报告 + leftover 存档 + work 即清 |
| 收尾 | uninstall 后注册表/清单/档案全清，日志按需保留 |
