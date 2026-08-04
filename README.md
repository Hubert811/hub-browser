# @hub/browser

把任何网站变成 CLI 的浏览器自动化工具（hub）。`hub` 驱动真实浏览器（BrowserClaw / Chromium CDP），agent 在 **task space（任务空间）** 内操作页面，共享用户 cookie / localStorage，无需重复登录。

- **纯 Node CLI**：`node >= 20`，无 Bun 依赖，无浏览器打包（驱动外部浏览器 CDP）。
- **MCP 原生**：`hub --mcp` 作为 stdio MCP server，外部 agent 可直接接入。
- **Space 隔离**：agent 必须先 `hub space create` 才能操作页面；多 agent 各占各的空间，tab 自动分组、人类拖入/拖出双向同步。
- **176+ 站点适配器**：`hub <site> <command>`（zhihu / bilibili / imdb / gitee …），`hub list` 发现。

---

## 安装

要求：**Node.js >= 20**。运行时需要一个可连接的浏览器（见 [浏览器依赖](#浏览器依赖)）。

### 方式 1：npm registry 安装

```bash
npm install -g @hub/browser
```

> 若尚未发布到公共 registry，可用方式 2 / 3。

### 方式 2：本地 tgz 文件安装（无需 registry）

在本机打包：

```bash
cd hub-browser
npm pack          # 生成 hub-browser-<version>.tgz（当前 0.1.1，自动跑 prepack 构建）
```

把生成的 `hub-browser-<version>.tgz`（如 `hub-browser-0.1.1.tgz`）拷贝到目标机器，然后：

```bash
npm install -g ./hub-browser-<version>.tgz
```

安装后 `hub` 即注册到 PATH。tgz 里包含完整运行时（`dist/` 编译产物 + `clis/` 适配器 + manifest），postinstall 会自动建立包内符号链接，无需额外步骤。

### 方式 3：git 仓库安装（https，公开仓库无需 ssh key）

```bash
# 默认分支（https 方式，任何机器可装，无需配置 GitHub ssh key）
npm install -g git+https://github.com/Hubert811/hub-browser.git
# 指定 tag / 分支
npm install -g git+https://github.com/Hubert811/hub-browser.git#v0.1.0
```

npm 会 clone 仓库并执行 `prepack`（构建）与 `postinstall`（符号链接）。

> ⚠️ 不要用 `npm install -g github:Hubert811/hub-browser`（`github:` 简写默认走 ssh，未配置 ssh key 的机器会报 `Repository not found`）。仓库是公开的，https 方式即可。

### 方式 4：私有 registry（团队内部）

自建 [Verdaccio](https://verdaccio.org/) 或使用 GitHub Packages，然后：

```bash
# 发布侧
npm publish --registry http://your-verdaccio:4873

# 安装侧
npm install -g @hub/browser --registry http://your-verdaccio:4873
```

---

## 快速开始

```bash
# 1. 浏览器依赖：确认 CDP 端口可达（v0.1.1 起自动探测，无需手动设端口）
curl http://127.0.0.1:9110/json/version   # 本机 BrowserClaw 的 CDP 端口；见「浏览器依赖」

# 2. 看有哪些命令 / 站点
hub list -f json          # 全部命令（JSON，agent 友好）
hub --help

# 3. 建任务空间（agent 操作 tab 的前提！）
hub space create "我的任务"    # → space id

# 4. 跑一个适配器（自动在 space 内开 tab 并归组）
hub imdb top --limit 2 -f plain

# 5. 管理空间
hub space current          # 当前空间 + tab 归属
hub space list
hub space close <id>       # 默认关掉该 space 全部 tab
```

### 作为 MCP server 接入 agent

```bash
BROWSEROS_CDP_PORT=9110 hub --mcp   # 端口可省略：v0.1.1 起自动探测（见「浏览器依赖」）
```

外部 agent 以 stdio 连入，获得 `space.*` / `tabs` / `snapshot` / `act` / `read` / `grep` / `diff` / `evaluate` / `download` / `upload` / `pdf` / `screenshot` / `tab_groups` / `windows` / `history` 等工具。

---

## 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `BROWSEROS_CDP_PORT` | 自动探测（env → BrowserClaw 配置 `ports.cdp` → `9005`） | 浏览器 CDP 调试端口显式覆盖；不设时自动读 BrowserClaw 配置（v0.1.1 起，决策 D7） |
| `BROWSEROS_DIR` | `~/.hub` | 用户数据根目录（space 账本、缓存、适配器等） |
| `HUB_DAEMON_PORT` | `9300` | hub daemon 端口（CLI 转发给常驻 daemon） |
| `HUB_SPACES_FILE` | `$BROWSEROS_DIR/state/hub-spaces.json` | space 账本文件覆盖 |
| `HUB_AGENT_ID` | `cli:local` | 身份标识（多 agent 并发时各自唯一） |
| `BROWSERCLAW_DIR` | — | 覆盖 BrowserClaw 配置目录（用于 `ports.cdp` 自动探测；默认 macOS `~/Library/Application Support/BrowserClaw`、Windows `%APPDATA%/BrowserClaw`、Linux `~/.config/BrowserClaw`） |
| `HUB_MCP` / `--mcp` | — | 以 stdio MCP server 模式运行 |
| `OPENCLI_BROWSER` | `claw`（hub 强制） | 浏览器后端，由 `bin/hub.mjs` 固定设为 `claw`（BrowserClaw），不是用户配置项 |

---

## 浏览器依赖

`hub` 本身**不含浏览器**——它通过 CDP 驱动一个已运行的浏览器。推荐：

- **BrowserClaw**（融合目标，默认）：启动后 CDP 端口由 BrowserClaw 配置决定（本机通常 9110）；
- 任意支持 CDP 的 Chrome / Chromium：用 `--remote-debugging-port` 启动后把 `BROWSEROS_CDP_PORT` 指过去。

**CDP 端口自动探测（v0.1.1 起，决策 D7）**：不再需要手动设端口，解析顺序：

1. `BROWSEROS_CDP_PORT` 环境变量（显式覆盖，最高优先）；
2. BrowserClaw `config.json` 的 `ports.cdp`——macOS `~/Library/Application Support/BrowserClaw/.browseros/config.json`、Windows `%APPDATA%/BrowserClaw/.browseros/config.json`、Linux `~/.config/BrowserClaw/.browseros/config.json`；`BROWSERCLAW_DIR` 可覆盖整个配置目录；dev 变体 `.browseros-dev` 优先探测；结果进程内缓存，不重复读盘；
3. 都读不到 → fallback `9005`（v0.1.1 之前的旧默认）。

登录态：浏览器里登录过的站点（zhihu / bilibili / …），`hub` 直接继承 cookie，无需重复登录。

---

## Space 概念（必读）

`hub` 与普通浏览器 CLI 的最大区别：**没有 space 就没有页面操作**。

- agent 必须先 `hub space create`（或 MCP `space.create`）才有空间；
- 无 space 时 `hub browser *` / 适配器命令 / MCP 页面工具全部拒绝（`no-space`）；
- space 的 tab 自动形成 tab group（以 space 命名 + 确定性颜色），人类在浏览器里拖入/拖出 tab 会同步回账本；
- 多 agent 各占各 space，互不可见、不可操作。

```bash
hub space create "搜索任务"
hub browser <session> tab list   # 看 space 内 tab（CLI 没有 `space list_tabs`；等价物是 `browser tab list`）
hub space close <id>          # 关闭 space 及其全部 tab
hub space handoff <id>        # 交给用户接管（agent 被拒）
hub space takeover <id>       # 用户确认后取回
```

---

## 开发（本仓库）

```bash
bun install          # 安装依赖 + postinstall 建符号链接
bun run build        # 编译 dist/（prepack 会自动跑）
bun test src/browser-mcp/src src/space tests/*.test.ts
bun run typecheck
```

### 从源码构建 / 发布（npm 包，决策 D6）

- `bun run build`（等价 `npm run build`；脚本 `scripts/build-dist.mjs`，内部用 bun）把 TS 源码 + `vendor/` 三包编译进 `dist/`；`npm pack` 前 `prepack` 会自动跑构建。
- `npm pack` 生成 `hub-browser-<version>.tgz`，内容由 `package.json` 的 `files` 白名单控制（`bin/`、`dist/`、`clis/`、`cli-manifest.json`、`scripts/postinstall.mjs`）。
- `npm install -g <tgz>` 时 postinstall（`scripts/postinstall.mjs`）自动建包内符号链接（`@jackwener/opencli` → 包内引擎、`@browseros/*` → 包内 vendor），无需额外步骤。
- 发布：`npm publish --access public`（`publishConfig.access: public` 已配置；`engines.node >= 20`）。

- `vendor/` 为只读 submodule（BrowserOS 依赖源码），发布时编译进 `dist/vendor/`（见上方「从源码构建 / 发布」）。

---

## License

- 本项目大部分（含 BrowserOS 依赖编译部分）：**AGPL-3.0-or-later**（见 `vendor/browseros/LICENSE`）。
- 引擎 fork（源自 opencli）：**Apache-2.0**。
- 组合声明：`(AGPL-3.0-or-later AND Apache-2.0)`。
