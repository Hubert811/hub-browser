# Phase 6 — Chromium 构建 + 打包

> 状态：⏳ 部分完成（2026-08-04：D6 npm 分发 + D7 CDP 端口自动探测已落地；2026-08-05：BrowserClaw 基线 debug 构建已跑通；BrowserOS 0.49.6 同步后产物名改为 BrowserOS neo）
> 预估：5-7 天
> 依赖：Phase 3 + Phase 5 完成
> 注：Phase 7（Space 浏览器 UI）依赖本阶段的构建产物，其 UI 补丁在本阶段构建管线中迭代（可与 5.4 补丁同批次）。

## 目标

用 BrowserOS neo（原 BrowserClaw）的构建系统，把融合后的 Chromium patches 编译成可分发的浏览器 .app。

## 前置条件

| 要求 | 详情 | Phase 1-5 期间是否需要 |
|---|---|---|
| 磁盘空间 | ~100GB（源码 + 构建产物） | ❌ 不需要 |
| Python | 3.12+ | ✅ 已有 |
| Xcode 完整版 | 不是 CommandLineTools | ❌ 不需要 |
| depot_tools | gclient/gn/ninja | ❌ 不需要 |
| 编译时间 | 2-6 小时（M4 Pro） | — |

**Phase 1-5 用已有 Chrome 做 CDP 后端验证逻辑，不需要构建 Chromium。Phase 6 是最后一步，把所有改动编译进自己的浏览器。**

> ⚠️ 预估 5-7 天而非 2-3 天：首次构建带自定义补丁的 Chromium fork，补丁冲突、编译错误、链接问题几乎必然出现。2-6 小时只是纯编译时间，不含调试。预留 5-7 天更现实。

## 代码位置

```
~/hermes-tmp/browseros/packages/browseros/
├── bos_build/               # Python 构建系统 CLI
│   ├── browseros.py         # 主入口
│   ├── cli/                 # 子命令 (build/source/product/dev/release/ext/ota)
│   ├── core/                # 构建管道 (context/pipeline/planner/resolver/runner/step)
│   ├── steps/               # 构建步骤 (source/prep/build/sign/package/upload)
│   └── config/              # 构建配置
├── chromium_patches/        # 打在 Chromium 上的补丁
│   ├── .features.yaml       # 补丁功能注册表
│   ├── chrome/browser/      # 浏览器 UI + 功能补丁
│   ├── content/             # 内核层补丁 (target_handler 等)
│   ├── extensions/          # 扩展 API 补丁
│   └── third_party/         # Sparkle 更新 + CDP 域定义
├── series_patches/          # 顺序补丁
├── resources/               # 图标/签名/entitlements
├── CHROMIUM_VERSION         # Chromium 148.0.7778.97
├── BASE_COMMIT              # 基础 commit
└── pyproject.toml           # Python 项目配置
```

## 操作步骤

### 6.1 安装构建依赖

```bash
# 确认 Xcode 完整版
xcode-select -p
# 如果是 CommandLineTools，需要安装完整 Xcode：
sudo xcode-select --install
# 或从 App Store 安装 Xcode

# 确认 depot_tools
which gclient && which gn && which ninja
# 如果没有（Phase 0 没装），现在装
```

### 6.2 安装构建系统

```bash
cd ~/hermes-tmp/browseros/packages/browseros
pip install -e .
# 或用 uv
uv pip install -e .
```

### 6.3 拉取 Chromium 源码

```bash
# ~40GB 下载
uv run browseros source ensure --root ~/work/chromium --step checkout
# 这步会拉取 Chromium 148 的源码

# 安装依赖
uv run browseros source ensure --root ~/work/chromium --step sync
# 这步安装 Chromium 构建需要的工具链
```

### 6.4 应用补丁

```bash
cd ~/hermes-tmp/browseros/packages/browseros
export PATH="$HOME/depot_tools:$PATH" BROWSEROS_NINJA_JOBS=8
# 应用 BrowserOS neo 原有补丁 + 我们的融合改动
uv run browseros build --preset debug --product browserclaw --arch arm64 \
  --chromium-src ~/work/chromium/src --provision none --no-download \
  --modules resources,bundled_extensions,chromium_replace,string_replaces,patches
```

这会把 `chromium_patches/` 里的所有补丁以及资源 staging 打到 Chromium 源码上，包括：
- BrowserOS neo 原有补丁（server/CDP 域/品牌/onboarding 等）
- （可选）Phase 5.4 的真隔离补丁（若启用）
- （可选）Phase 7 的 Space UI 补丁（若已开发）

> 注：Phase 3（空间分配）是纯客户端实现，**不产生 Chromium 补丁**。Phase 5 的虚拟指针拦截已暂缓，不在此列。

### 6.5 构建

```bash
# 调试构建（增量续跑）
uv run browseros build --preset debug --product browserclaw --arch arm64 \
  --chromium-src ~/work/chromium/src --provision none --no-download \
  --from configure

# Release 构建
uv run browseros build --preset release --product browserclaw --arch arm64 \
  --chromium-src ~/work/chromium/src --provision none --no-download
```

构建参数：
- `--preset debug|release`：构建配置
- `--product browserclaw|browseros`：产品；BrowserOS neo 仍使用 `browserclaw` 产品 ID
- `--arch arm64|x64`：目标架构
- `--chromium-src`：Chromium 源码路径
- `--provision none --no-download`：本地无 R2 密钥时跳过私有下载
- `--from configure`：从 configure 开始增量续跑（compile → package_macos）
- `--modules`：只跑指定构建模块（resources/patches/configure/compile/package_macos 等）

### 6.6 签名

```bash
# macOS 代码签名
browseros sign --chromium-src ~/work/chromium/src
```

如果没有 Apple 开发者证书，可以用 ad-hoc 签名（本地开发够用）。

### 6.7 打包

```bash
# 打包成 .app
browseros package --chromium-src ~/work/chromium/src
# → 输出到 ~/work/chromium/src/out/Release/BrowserOS.app
```

### 6.8 验证

```bash
# 拷贝到 Applications
cp -r ~/work/chromium/src/out/Release/BrowserOS.app /Applications/

# 启动
open -a BrowserOS

# 验证 CDP 端口
curl http://127.0.0.1:9000/json/version
# 应返回 Chromium 版本信息

# 验证 MCP 端口
curl http://127.0.0.1:9100/system/health
# 应返回 ok

# 验证自定义 CDP 域
curl http://127.0.0.1:9000/json/list
# 应看到 page targets

# 用 OpenCLI 连接
OPENCLI_BROWSER=claw opencli browser state
# 应正常返回页面快照
```

## 构建系统命令参考

```bash
uv run browseros source ensure --root <path> --step checkout   # 拉取 Chromium 源码
uv run browseros source ensure --root <path> --step sync       # 安装 Chromium 依赖
uv run browseros build --preset debug --product browserclaw --arch arm64 \
  --chromium-src <path> --provision none --no-download \
  --modules resources,bundled_extensions,chromium_replace,string_replaces,patches  # 资源 + 补丁
uv run browseros build --preset debug --product browserclaw --arch arm64 \
  --chromium-src <path> --provision none --no-download --from configure          # 编译 + 打包
uv run browseros build --preset release --product browserclaw --arch arm64 \
  --chromium-src <path> --provision none --no-download                           # Release
uv run browseros release --help                                                   # 发布自动化
uv run browseros dev --help                                                       # 开发/补丁管理
```

## 补丁管理

如果要加新补丁（比如 Phase 3/5 的改动）：

```bash
# 1. 在 Chromium 源码里做修改
cd ~/work/chromium/src
# 编辑文件...

# 2. 用工具提取补丁
browseros dev extract --file path/to/modified/file.cc

# 3. 补丁自动放到 chromium_patches/ 对应路径

# 4. 在 .features.yaml 里注册补丁
# 编辑 chromium_patches/.features.yaml
```

## 可能的问题

1. **内存不够**：M4 Pro 24GB 编译 Chromium 可能 OOM。解决：限制并行度 `BROWSEROS_NINJA_JOBS=8`（24GB 安全上限，不要继续加大）
2. **编译时间过长**：首次 2-6 小时。增量编译会快很多（改一个文件只需几分钟）
3. **签名失败**：没有 Apple 开发者证书。解决：用 ad-hoc 签名 `codesign --force --deep --sign - "BrowserOS neo.app"`
4. **depot_tools 版本不匹配**：Chromium 148 需要特定版本的 depot_tools

## 验证标准

| 验证项 | 命令 | 预期结果 |
|---|---|---|
| 源码拉取 | `uv run browseros source ensure --root <path> --step checkout` | 无报错 |
| 资源/补丁 | `uv run browseros build --modules resources,...,patches` | 无报错 |
| 编译成功 | `uv run browseros build --preset debug ... --from configure` | 无编译错误 |
| .app 生成 | 同一 build 命令的 package_macos 阶段 | 生成 BrowserOS neo.app / BrowserOS neo Dev.app |
| 启动 | `open -a "BrowserOS neo"` | 浏览器正常打开 |
| CDP 端口 | `curl :9000/json/version` | 返回版本信息 |
| MCP 端口 | `curl :9100/system/health` | ok |
| OpenCLI 连接 | `OPENCLI_BROWSER=claw opencli browser state` | 返回快照 |
| 自定义 CDP 域 | CDP 调用 `Browser.getTabs` | 返回 Tab 列表 |
| Task Space | `opencli space create "test"` | 创建成功 |

## 完成标志

- [ ] Chromium 源码拉取成功
- [ ] 融合补丁应用成功
- [ ] 编译无错误
- [ ] .app 打包成功
- [ ] 浏览器能正常启动
- [ ] CDP + MCP 端口正常
- [ ] OpenCLI 能连接并操作
- [ ] 自定义 CDP 域可用
- [ ] Task Space 可创建
- [x] 统一 TS/JS 双份文件（见 6.9，2026-08-04）
- [x] CLI 以 npm 包分发 ✅（D6：`@hub/browser`，`files` 白名单 + prepack/postinstall 自建符号链接，2026-08-04）
- [x] CDP 端口自动探测 BrowserOS neo 配置 ✅（D7：`BROWSEROS_CDP_PORT` → config `ports.cdp` → 9005，2026-08-04）

## 6.9 统一 src/opencli/ 与 src/opencli-engine/browser/ 重复文件

> 来源：Confucius 全局审查 P2

**现状**：7 个同名文件存在双份——TS 版在 `src/opencli/`（给 UnifiedPage 用），JS 版在 `src/opencli-engine/browser/`（给引擎 cli.js/execution.js 用）：

| TS 版 (src/opencli/) | JS 版 (src/opencli-engine/browser/) |
|---|---|
| compound.ts | compound.js |
| dom-snapshot.ts | dom-snapshot.js |
| errors.ts | errors.js |
| stealth.ts | stealth.js |
| target-errors.ts | target-errors.js |
| target-resolver.ts | target-resolver.js |
| utils.ts | utils.js |

两份内容几乎一致（TS 版多个类型注解），但维护两份。`base-page.ts` 是唯一有改动的（4 处），JS 版 `base-page.js` 已删除。

**统一方案**：Phase 6 有 build 步骤（`tsc --outDir dist`）后：

1. `npm run build` 把 `src/opencli/*.ts` 编译到 `dist/opencli/*.js`
2. 把 `src/opencli-engine/browser/` 里 7 个重复 JS 文件删除
3. 修改引擎 import 路径：从 `./browser/compound.js` 改为 `../../dist/opencli/compound.js`（或配置 path alias）
4. 验证引擎能正确 import 编译产物
5. 之后只需维护 TS 版，JS 版自动生成

**注意**：统一前要确认 TS 版和 JS 版没有实质性差异（除了类型注解）。可以用 `diff` 逐个比对。

**实际落地（2026-08-04）**：✅ 完成。
- 逐文件用 Bun transpiler 做去类型对比 + 导出集合核对：`compound / dom-snapshot / stealth / target-resolver / utils` 确认为**真重复**（JS=去类型 TS，无 JS 独有逻辑）→ 5 个 JS 改为薄重导出 `export * from '../../opencli/<name>.ts'`（与已完成的 `target-errors.js` 同款模式），净变化 +25 / -1991 行。
- 构建：build-dist.mjs 把 `.ts` 改写为 `.js`，发布包 `dist/opencli-engine/browser/*.js` → `dist/opencli/*.js`，dev（bun）直接解析 `.ts`，双路径验证通过。
- `errors.js` **保留**（审查误报）：它是 hub 简化 fork（`classifyBrowserError`/`isTransientBrowserError`/`formatBrowserConnectError`，imports `BrowserConnectError` from `../errors.js`），与 `src/opencli/errors.ts`（CliError/BrowserConnectError/EXIT_CODES）API 不同、独立演化，不是去类型副本。
- 验证：304 pass / 0 fail（与基线一致，零回归）、typecheck 0 error、`bun run build` 成功、live 冒烟（`browser state`/`find` 走 compound/dom-snapshot 路径）正常、外部适配器 `@jackwener/opencli/browser/utils` 导出一致。

## 6.10 统一 MCP 路径与 OpenCLI 路径的网页操作逻辑

> 来源：Phase 2.5 完成后的架构审查

**现状**：hub-browser 有两条网页操作路径，底层 CDP 连接相同，但网页操作逻辑不同：

| | MCP 路径（原有） | OpenCLI 路径（融合后） |
|---|---|---|
| **入口** | Agent 扩展 → `/chat` 或外部 Agent → `/mcp` | `hub.mjs` → OpenCLI engine |
| **网页操作层** | `browser-mcp` 工具 → `browser-core` Observer/Input | `UnifiedPage`（继承 OpenCLI BasePage）|
| **快照** | `Observer.snapshot()` → AX Tree + `eN` ref | `BasePage.snapshot()` → DOM + AX Tree，输出 `@N`/`eN` 双 ref |
| **点击/填充** | `Input` 类 → CDP `Input.dispatchMouseEvent` | `BasePage` → `Runtime.evaluate` 执行页面内 JS |
| **Visual Ref** | `screenshot-overlay.ts` + `screenshot-geometry.ts` | `UnifiedPage.annotatedScreenshot()` → `DOM.getBoxModel` 并行取坐标 |
| **Ref 解析** | `Observer.resolveRef` → `backendNodeId` + `(frameId, role, name, nth)` | `target-resolver` 三级降级 → `backendNodeId` → `fingerprint` → `reidentified` |

两条路径各自工作正常（Phase 2.5 已验证），但不统一：
- 同一个 `e5` ref 在两条路径里的解析行为可能有细微差异
- Agent 扩展（`apps/app`）和外部 MCP Agent 走的是 `browser-mcp` 原有代码，不走 `UnifiedPage`
- 维护两套网页操作逻辑增加长期维护成本

**统一方案**：把 `browser-mcp` 的工具 handler 从调用 `browser-core` 的 `Observer`/`Input` 改为调用 `UnifiedPage` 的方法。`browser-mcp` 的工具定义、MCP 协议层、Zod schema 验证不动，只替换 handler 内部实现。

**约束**：`browser-mcp` 在 `vendor/browseros/` git submodule 里（只读），不能直接修改。可选方案：

- **方案 A（fork）**：像 OpenCLI 一样把 `browser-mcp` 拷贝到 `src/browser-mcp/`，在副本上改 handler。优点是改动直接；缺点是多维护一份 fork
- **方案 B（适配器层）**：在 `src/` 下新建一个适配器，包装 `UnifiedPage` 使其满足 `browser-mcp` 的 `ToolContext.session` 接口。`browser-mcp` 通过依赖注入接收适配器，不改 vendored 代码。优点是不 fork；缺点是接口适配可能有摩擦
- **方案 C（渐进式）**：先只统一核心工具（snapshot/act/click/fill），其余工具（tabs/windows/history/bookmarks/pdf/download/upload）暂保留 `browser-core` 实现，因为这些工具调的是 CDP 域而非网页操作层，不涉及两套逻辑分歧

**建议**：方案 C（渐进式），先统一有分歧的核心工具，风险低且见效快。tabs/windows/history 等工具本来就没有两条路径分歧（都走 CDP 域），不需要统一。

**影响范围**：
- Agent 扩展（`apps/app`）通过 `/chat` 调用 `browser-mcp` → 统一后 Agent 扩展也走 `UnifiedPage` 逻辑
- 外部 MCP Agent 通过 `/mcp` 调用 `browser-mcp` → 同上
- OpenCLI 路径不变，本来就是 `UnifiedPage`

**前置条件**：
- Phase 2 + 2.5 完成（已完成）
- 不阻塞 Phase 3/4/5，可与它们并行
- 最终构建前完成，确保打包的浏览器只有一套网页操作逻辑

**完成标志**：
- [x] 核心工具（snapshot/act/click/fill）的 handler 改为调用 `UnifiedPage` ✅（2026-08-04：`src/browser-mcp` fork 的**全部**工具都走 UnifiedPage，不只是核心工具）
- [ ] Agent 扩展 `/chat` 路径验证通过（BrowserOS neo `apps/app` 产品面，非 hub-browser 范围）
- [x] 外部 MCP `/mcp` 路径验证通过 ✅（`hub --mcp` stdio server 即 fork + UnifiedPage，冒烟通过）
- [x] OpenCLI 路径不受影响 ✅（本就是 UnifiedPage）
- [x] 两条路径的 ref 解析行为一致 ✅（MCP 工具与 CLI 共用 UnifiedPage target-resolver）

## 实际进展

**状态：⏳ 部分完成（2026-08-04：D6 npm 分发 ✅、D7 CDP 端口自动探测 ✅、6.9 重复文件统一 ✅、6.10 核心统一 ✅；Chromium 构建未开始）**

### 已添加的待办
- 6.9 统一 TS/JS 重复文件（来自 Confucius 审查 P2）——**✅ 已完成（2026-08-04）**：见下方 6.9 节更新
- 6.10 统一 MCP 路径与 OpenCLI 路径的网页操作逻辑（来自架构审查）——**核心已落地**：`src/browser-mcp` fork 全部工具经 `UnifiedPage` 操作页面

### 已完成的前置工作
- hub-browser 命令功能验证完成，所有 P0 bug 修复
- CDP 持久化 daemon 模式实现（6.10 的前置：两条路径共用同一个 CDP 连接）

## 决策 D6（2026-08-04）：CLI 分发用 npm 包（方案 A）

**选型**：`@hub/browser` 以 npm 包发布（`npm i -g @hub/browser`），作为 Phase 6 的 CLI 分发部分。

**关键事实（已核实）**：
- `hub` 是纯 Node CLI（`node bin/hub.mjs` 可跑，无 Bun 专属 API）；引擎 fork 纯 JS。
- 运行时依赖 vendor 三包：`@browseros/browser-core`（248K）、`cdp-protocol`（688K）、`shared`（128K）——**纯 TS 源码无 dist**，经 workspace 链接。
- 适配器 `clis/`（13MB）+ `cli-manifest.json`（1MB）需随包发布（合计 ~15MB，可接受）。
- ABI shim：适配器 `import '@jackwener/opencli/*'`，方案 C 在 `~/.hub/node_modules` 建符号链接（postinstall/首次运行自建）。
- `hub` 驱动外部浏览器（`BROWSEROS_CDP_PORT`），包不含浏览器（BrowserOS neo `.app` 是另一层）。

**实现要点**：
1. `bun run build`（`tsc --outDir dist`）把 TS（src/space、src/browser-mcp、src/page.ts、src/factory.ts、vendor 三包）编译进 dist。
2. `files` 白名单：`bin/`、`dist/`、`clis/`、`cli-manifest.json`、`src/opencli-engine`、`src/browser-mcp`（如未全进 dist）、`src/space`、`src/opencli`、`vendor` 三包源码（或编译产物）。
3. `postinstall` 调整：发布后不依赖相对路径 workspace 链接，改为包内自建符号链接（@jackwener/opencli → 包内引擎、@browseros/* → 包内 vendor）或直接用 dist 产物路径。
4. `publishConfig.access: public`。
5. 验证：`npm pack --dry-run` 看包内容；`npm i -g <tgz>` 干净环境测 `hub list`、`hub --mcp`、建 space + 适配器命令。

## 决策 D7（2026-08-04）：CDP 端口自动探测 BrowserOS neo 配置

**问题**：`hub` 默认找 `9005` 端口，但 BrowserOS neo（原 BrowserClaw）的 CDP 端口是配置动态分配的（本机 `~/.browseros/config.json` 的 `ports.cdp = 9110`），另一台机器装完 BrowserOS neo 不设 `BROWSEROS_CDP_PORT` 就连不上（"CDP discovery failed ... fetch failed"）。

**方案**：`src/factory.ts` 端口解析加 BrowserOS neo 配置探测：
1. `BROWSEROS_CDP_PORT` 环境变量优先（显式覆盖）；
2. 未设置 → 读 BrowserOS neo config.json 的 `ports.cdp`（配置目录仍叫 `BrowserClaw`；macOS: `~/Library/Application Support/BrowserClaw/.browseros/config.json`；dev: `.browseros-dev`；Windows/Linux 对应路径；也可探测 `BROWSERCLAW_DIR`）；
3. 读不到 → fallback 9005。
- 探测结果做进程内缓存（避免每次 connect 读盘）；配置文件不存在/无 ports.cdp 时静默 fallback。
- 这是唯一入口：engine 的 `getBrowserFactory` 返回 `UnifiedBrowserFactory`，vendor `browser-core/cdp.ts` 只接收 port，无需改 vendor。
