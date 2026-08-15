# npm 发布指南（@dsh-tools/dsh-install）

前置：真机验证已通过（见 [verify-checklist.md](verify-checklist.md) 与
`scripts/verify-run.ps1`），包名/scope 已定，tarball 在 `.local/dist/`。

## 1. 发布前检查（一次性，每次发布重复）

```console
pnpm --dir packages/dsh-install run typecheck
pnpm --dir packages/dsh-install run test          # 136 测试
pnpm --dir packages/dsh-install run build
pnpm --dir packages/dsh-install pack --pack-destination ..\..\.local\dist
```

## 2. npm 账号与 scope（一次性）

- 注册：浏览器打开 https://www.npmjs.com/signup（免费，1 分钟）。
- `npm login` 登录（会弹浏览器，粘贴一次性验证码）。
- scope `@dsh-tools` 必须归你的账号所有：`npm org create dsh-tools`
  （或 npmjs.com → Create Organization）。`publishConfig.access: "public"`
  已配置——scoped 包默认 restricted，没有这一行用户装不了。
- 注意：npm 自 2022 起发布强制双因素认证（2FA），`npm publish` 时会向
  验证器 App 要一次性码；发布若报 `403/E404`，先检查 scope 是否已建、
  是否属于当前登录账号。

## 3. 发布

```console
npm publish "D:\Workspace\DSH-Install-MCP&Skill\.local\dist\dsh-tools-dsh-install-0.1.0.tgz"
```

> PowerShell 下路径必须加双引号：项目根路径含 `&`，不加引号会被
> PowerShell 当特殊运算符解析（ParserError: AmpersandNotAllowed）。

版本管理：每次发布前 bump `packages/dsh-install/package.json` 的 version
（0.1.0 → 0.2.0 …），重新 pack，重复第 1 步。

## 4. 发布后冒烟（用户视角，等价命令）

```console
dsh plugin --profile install add @dsh-tools/dsh-install
dsh --profile install mcp add github
dsh --profile install skills add github:anthropics/skills#skills/docx
dsh --profile install mcp list
```

- 注意：spec 为包名时无路径字符问题，`&` 截断问题只影响本地路径 spec。
- 长驻 profile（web/tui）另装一份并启用 `mcp-registry` 行（见 README）。

## 5. 可选：社区市场收录

发布完成后，按各 hub 的收录格式提交条目（whalehub-dsh、dsh-plugin-hub、
awesome-deepseek-harness 等）。本插件自带市场协议端，任何 catalog 皆可消费；
是否自建 catalog 内容（最小版市场）另行决策。
