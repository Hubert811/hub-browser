# BrowserOS 0.49 / BrowserOS neo 更新对 hub-browser 的同步影响

> 分析日期：2026-08-07
> 分析基准：hub-browser `5c766859`，vendor/browseros `80cb442`（旧 pin），BrowserOS `origin/main` `4d341b8`（v0.49.6）

## 结论

这次 BrowserOS 更新不会直接破坏 hub-browser 当前的 TypeScript import 和 replay HTTP 调用。需要真正同步的是：

1. `vendor/browseros` submodule 指针，并重新安装/构建依赖。
2. `bun.lock` 中 BrowserOS workspace 元数据。
3. 发布包 `dist/` 和 tarball（如果会 prepack / publish）。
4. BrowserOS neo 改名带来的文档、CLI 文案、skill 和测试断言。
5. 上游 tab cleanup 从 2h 改为 1h 后，与 hub-browser 自身 space TTL 的语义确认。

## 1. 必须同步

### 1.1 vendor/browseros submodule

`hub-browser` 通过 workspace 和 postinstall 直接读取
`vendor/browseros/packages/browseros-agent/packages/*`。
当前 submodule 停在旧 commit，需要更新到与 `~/hermes-tmp/browseros` 一致的 BrowserOS 最新版本。

建议 pin 到 `4d341b821b3e82f7424848a7b06f33b9d91a4483`（对应 `BROWSEROS_VERSION=0.49.6`）。

```bash
cd /Users/hubertxie/Downloads/opencli\ +\ browserClaw/hub-browser
git -c http.version=HTTP/1.1 -C vendor/browseros fetch origin --prune
git -C vendor/browseros checkout 4d341b821b3e82f7424848a7b06f33b9d91a4483
git add vendor/browseros
git commit -m "chore: sync vendor/browseros to v0.49.6"
```

如果希望跟随 release tag 而不是 main，可以改用最近的 `claw-server/v0.0.26` / `claw-onboard/v0.0.15` 等 tag。当前项目原来 pin 的是 release 型提交，不建议长期追 main 而不锁版本。

### 1.2 bun install 与 bun.lock

`package.json` 的 workspaces 覆盖整个 `packages/*`：

```json
"vendor/browseros/packages/browseros-agent/packages/*"
```

新版 BrowserOS 改了 BrowserOS root package 的 postinstall/trustedDependencies，并把
`@browseros/acpx-ai-provider` 的 `acpx` peerDependency 从 `>=0.8.0` 收紧到 `^0.13.0`。
当前 `bun.lock` 仍记录 `>=0.8.0`，所以更新 vendor 后需要重新生成 lockfile：

```bash
cd /Users/hubertxie/Downloads/opencli\ +\ browserClaw/hub-browser
bun install
git diff bun.lock
```

新版没有新增或删除 `packages/browseros-agent/packages/*` 顶层包目录，所以 workspace 通配符和 postinstall 的 vendor symlink 结构仍然有效。

### 1.3 重建 dist / tarball

`scripts/build-dist.mjs` 会拷贝并转译三个 BrowserOS 包：

```js
const VENDOR = {
  'browser-core': '.../browser-core',
  'cdp-protocol': '.../cdp-protocol',
  'shared': '.../shared',
};
```

`dist/` 是 ignored 产物，但如果要 prepack / publish，更新 vendor 后必须重建：

```bash
bun run build
```

### 1.4 验证

```bash
bun run typecheck
bun run build
bun test
```

## 2. 已确认兼容、不需要改代码

### 2.1 hub-browser 直接 import 的 BrowserOS API

hub-browser 只直接使用：

- `@browseros/browser-core`
- `@browseros/cdp-protocol/protocol-api`
- `@browseros/shared/constants/timeouts`
- `@browseros/shared/constants/limits`
- `@browseros/browser-core/core/snapshot/diff`
- `@browseros/browser-core/content-markdown`
- `@browseros/cdp-protocol/domains/history`

新旧对比中：

- `browser-core` 无差异。
- `cdp-protocol` 无差异。
- `shared` 只改了 `constants/urls.ts`、`env/registry.ts`、`schemas/llm.ts`，并新增 `schemas/agent.ts`；hub-browser 没有引用这些被改动的 subpath。

因此 `tsconfig.json` paths、`scripts/postinstall.mjs` 和 `scripts/build-dist.mjs` 不需要改。

### 2.2 replay HTTP API

hub-browser 的 `replay` CLI 使用：

- `GET /api/v1/sessions`
- `GET /api/v1/sessions/{id}/recording`
- `GET /api/v1/sessions/{id}/recording/events`

旧版和新版都保留这些路由；新版额外增加了 `/recording/live`，不影响现有调用。

### 2.3 CDP 配置目录

新版 BrowserOS neo 的产品名变了，但 BrowserClaw product 的用户数据目录 patch 仍使用 `BrowserClaw`：

- `browseros_product_dir_name = "BrowserClaw"`
- claw-server 状态目录仍是 `.browserclaw`
- env override 仍是 `BROWSERCLAW_DIR`

所以 `src/cdp-port.ts` 继续探测
`~/Library/Application Support/BrowserClaw/.browseros[-dev]/config.json`
是正确的，不要因为改名把配置目录改成 `BrowserOS neo`。

### 2.4 browser-mcp fork

上游 `@browseros/browser-mcp` 在本次更新中没有差异。
hub-browser 的 `src/browser-mcp` 已经是明显分叉（包含 space 工具、session adapter、自定义测试），不需要从新版上游自动合并。

## 3. 行为差异，需要确认或显式配置

### 3.1 upstream tab cleanup 从 2h 改为 1h

新版 `claw-server-rust`：

- 默认 `CLAW_SESSION_RETENTION_MS` 从 2h 改为 1h。
- 新增 `tab_cleanup` sweeper，会把已无 live owner 的 agent tab 在保留窗口后关闭。
- 同时把 agent tab 和 group 保留 1 小时。

hub-browser 自己的 space ledger TTL 是空 space 24h / agent space 7d，和 upstream 的 1h 是两层语义，不必然冲突，但要确认实际使用 BrowserOS neo 原生 MCP/server 时，1h 后的 tab 被上游关掉是否符合 hub-browser 的 `space.close {keep}` 预期。

如需要保持更久，可以在 BrowserOS server 端设置：

```bash
CLAW_SESSION_RETENTION_MS=7200000
```

### 3.2 MCP identity 改为 browseros-neo

新版 `shared/src/constants/urls.ts` 把
`BROWSEROS_MCP_SERVER_NAME` 从 `BrowserClaw` 改为 `browseros-neo`；
新版 skill 名称也改为 `browseros-neo`。

hub-browser 当前没有 import 这个常量，自己的 `src/browser-mcp` 也不是 BrowserOS native MCP。但如果 hub-browser 的文档/流程会向 Claude Desktop、Codex 等客户端写入 BrowserOS neo 原生 MCP 配置，应使用 `browseros-neo`。

### 3.3 BrowserOS neo 品牌与产物名

新版 Chromium 覆盖层和 `bos_build` 已经把 BrowserClaw product 的显示名改为 `BrowserOS neo`：

- macOS app 名：`BrowserOS neo.app` / `BrowserOS neo Dev.app`
- Windows install identity：`BrowserOS neo`
- bundle id / updater 内部标识仍保留 `com.browseros.BrowserClaw`

这会影响构建文档、启动命令、验收路径，但不会改变 `BROWSERCLAW_DIR` / CDP config 探测路径。

## 4. 建议同步的文案/品牌位置

这些改动不影响运行逻辑，但会让 hub-browser 对新版产品名的描述保持一致：

- `README.md`：BrowserClaw 安装/下载/说明段落，以及 `docs.browseros.com/browserclaw` 链接。
- `skills/hub-browser/SKILL.md`：description 里的 BrowserClaw。
- `skills/hub-browser-browser/SKILL.md`：端口探测说明里的 BrowserClaw。
- `src/opencli-engine/cli.js`：replay 命令的 description、`--base-url`、错误提示。
- `src/opencli-engine/browser/errors.js`：连接错误提示。
- `tests/phase4-replay-cli.test.ts`：依赖 `replay depends on the BrowserClaw server` 的断言。
- `docs/phase-*` 中的构建产物名和验收命令。

注意：只改显示文案，不要改 `src/cdp-port.ts` 中的 `BrowserClaw` 配置目录。

## 5. 推荐执行顺序

1. 更新并提交 `vendor/browseros` submodule。
2. `bun install` 更新 lockfile 和 workspace symlink。
3. `bun run typecheck` + `bun run build` 验证。
4. 跑 `bun test`，重点看 replay 文案和 space 相关测试。
5. 确认是否要跟随 BrowserOS neo 改名，批量更新 README/skills/CLI 文案。
6. 若继续构建浏览器，按新版产物名 `BrowserOS neo.app` 更新 handoff/验收文档。

## 6. 执行记录（2026-08-07）

以下同步和验证已经完成：

- `vendor/browseros` 已更新到 `4d341b821b3e82f7424848a7b06f33b9d91a4483`。
- `bun.lock` 已更新：`acpx` peerDependency 改为 `^0.13.0`，清理 root 中多余的 workspace 依赖记录。
- `tsconfig.json` 增加 `@browseros/*` 子路径映射，避免本地 postinstall 链接到 dist JS 后 tsc 找不到 vendor 源码类型。
- `scripts/postinstall.mjs` 改为本地开发优先链接 `src/`，发布场景缺少源码时仍回退 `dist/`。
- README、hub skills、CLI/error 文案、相关测试、构建文档已跟随 BrowserOS neo 品牌同步；CDP 配置目录仍保留 `BrowserClaw`。
- 核心测试：304 pass / 0 fail（35 个文件，显式文件清单，排除 `clis/` 的 vitest 用例）。
- `bun run typecheck`：通过。
- `bun run build`：通过，dist 已重建。
- `bun run test`（真实 BrowserOS neo CDP 9110）：12/12 通过。
- `bun run test:session-adapter`：17/17 工具跑通，退出 0。

未纳入本次执行范围的测试：

- `clis/` 下的适配器测试使用 `vi.runAllTimersAsync` / `vi.stubGlobal`，需要 vitest 环境；hub-browser 根包没有配置 vitest，未作为本仓库同步回归套件运行。
- BrowserOS vendor 自带的 Rust / MCP 测试不属于 hub-browser 测试套件，未在此运行。
