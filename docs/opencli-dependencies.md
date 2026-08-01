# OpenCLI 依赖清单

> OpenCLI 当前版本: 1.8.6
> 更新频率: 极低（已稳定）
> 本文档记录 hub-browser 对 OpenCLI 的依赖关系，方便 OpenCLI 更新时同步检查。

## 一、Patch（直接修改 node_modules）

### `dist/src/runtime.js` — getBrowserFactory 函数

**改动**: 在 `getBrowserFactory` 开头加 3 行，检查 `OPENCLI_BROWSER=claw` 环境变量。

```diff
  export function getBrowserFactory(site) {
+     // hub-browser patch: use UnifiedBrowserFactory when OPENCLI_BROWSER=claw
+     if (process.env.OPENCLI_BROWSER === 'claw') {
+         return globalThis.__HubBrowserFactory ?? BrowserBridge;
+     }
      if (site && isElectronApp(site))
          return CDPBridge;
      return BrowserBridge;
  }
```

**作用**: 让 OpenCLI 的执行引擎在 `OPENCLI_BROWSER=claw` 时返回 hub-browser 的 `UnifiedBrowserFactory`（连接 BrowserClaw CDP），而非默认的 `BrowserBridge`（Chrome 扩展）。

**Patch 管理**: `scripts/apply-patches.mjs` 在 `postinstall` 时自动应用。`bun install` 后自动执行。

## 二、拷贝到 hub-browser 的文件（已修改）

以下 14 个文件从 OpenCLI 拷贝到 `src/opencli/`，在副本上做修改：

| OpenCLI 原始文件 | hub-browser 位置 | 作用 | 改动 |
|---|---|---|---|
| `src/browser/base-page.ts` | `src/opencli/base-page.ts` | IPage 抽象基类 | 正则 `/^\d+$/` → `/^e?\d+$/`; private → protected; 加 resetPageState() |
| `src/browser/target-resolver.ts` | `src/opencli/target-resolver.ts` | 三级 stale-ref 匹配 | 无改动 |
| `src/browser/target-errors.ts` | `src/opencli/target-errors.ts` | 错误类型 | 无改动 |
| `src/browser/visual-refs.ts` | `src/opencli/visual-refs.ts` | Visual ref 叠加 | 无改动（2b: annotatedScreenshot 覆写在 page.ts） |
| `src/browser/stealth.ts` | `src/opencli/stealth.ts` | 反检测 JS | 无改动 |
| `src/browser/interceptor.ts` | `src/opencli/interceptor.ts` | 网络拦截 | 无改动 |
| `src/browser/compound.ts` | `src/opencli/compound.ts` | 复合组件识别 | 无改动 |
| `src/browser/dom-snapshot.ts` | `src/opencli/dom-snapshot.ts` | DOM 快照引擎 | 无改动 |
| `src/browser/ax-snapshot.ts` | `src/opencli/ax-snapshot.ts` | AX 快照 | 无改动 |
| `src/browser/dom-helpers.ts` | `src/opencli/dom-helpers.ts` | DOM 工具函数 | 无改动 |
| `src/browser/utils.ts` | `src/opencli/utils.ts` | evaluate 表达式构建 | 无改动 |
| `src/browser/errors.ts` | `src/opencli/errors.ts` | 浏览器错误类型 | 无改动 |
| `src/browser/snapshotFormatter.ts` | `src/opencli/snapshotFormatter.ts` | 快照格式化 | 无改动 |
| `src/browser/types.ts` | `src/opencli/types.ts` | 类型定义 | 无改动 |

**只有 base-page.ts 有改动（4 处）**，其余 13 个文件是原样拷贝。

## 三、OpenCLI 运行时使用（不修改，通过 npm 安装）

以下 OpenCLI 模块在运行时被 import，但不修改：

| 模块 | 作用 |
|---|---|
| `dist/src/main.js` | CLI 入口（适配器发现 + commander + runCli） |
| `dist/src/cli.js` | runCli 函数 |
| `dist/src/commanderAdapter.js` | commander 桥接 → executeCommand |
| `dist/src/execution.js` | executeCommand（调用 getBrowserFactory + browserSession） |
| `dist/src/runtime.js` | getBrowserFactory + browserSession **（已 patch）** |
| `dist/src/discovery.js` | 适配器发现 |
| `dist/src/registry.js` | 命令注册表 |
| `dist/src/pipeline/` | 声明式 pipeline 引擎 |
| `dist/src/capabilityRouting.js` | 判断是否需要浏览器 |
| `dist/src/observation/` | 多流 ring buffer |
| `dist/src/hooks.js` | 生命周期钩子 |
| `dist/src/browser/bridge.js` | BrowserBridge（Chrome 扩展，默认工厂） |
| `dist/src/browser/cdp.js` | CDPBridge（Electron CDP） |
| `dist/src/browser/page.js` | Page 类（BrowserBridge 的 page） |
| `dist/src/browser/profile.js` | Profile 路由 |
| `dist/src/electron-apps.js` | Electron 应用检测 |
| `dist/src/launcher.js` | CDP 端口探测 |
| `dist/src/logger.js` | 日志 |
| `dist/src/errors.js` | 错误类型 |
| `dist/src/adapter-source.js` | 适配器源码路径解析 |
| `clis/` | 176 个站点适配器 + 10 个应用适配器 |

## 四、数据流

```
用户执行: bun bin/hub.mjs duckduckgo search "test"

1. hub.mjs:
   - 设置 OPENCLI_BROWSER=claw
   - 设置 globalThis.__HubBrowserFactory = UnifiedBrowserFactory
   - import('@jackwener/opencli')  ← 运行 OpenCLI CLI

2. OpenCLI main.js:
   - discoverClis() → 发现 176 个适配器
   - runCli() → commander 解析命令 → executeCommand()

3. OpenCLI execution.js:
   - getBrowserFactory('duckduckgo')  ← runtime.js (patched)
   - runtime.js: OPENCLI_BROWSER=claw → return globalThis.__HubBrowserFactory
   - browserSession(UnifiedBrowserFactory, fn)

4. UnifiedBrowserFactory:
   - connect() → CdpBackend(port=9110) → BrowserSession → UnifiedPage
   - UnifiedPage extends BasePage → 适配器透明使用

5. 适配器:
   - page.goto('https://duckduckgo.com')  ← UnifiedPage → BrowserSession → CDP
   - page.snapshot()  ← Observer → AX tree + compound
   - page.click('e1')  ← tryClickAxRef → nativeClick → Input
   - 返回数据给用户
```

## 五、OpenCLI 更新检查清单

当 OpenCLI 发新版本时，检查以下文件：

1. **`dist/src/runtime.js`** — 检查 `getBrowserFactory` 是否变了，重新应用 patch
2. **`dist/src/browser/base-page.ts`**（或编译后的 `.js`）— 检查 4 处改动是否需要同步
3. **`dist/src/execution.js`** — 检查 `getBrowserFactory` 调用方式是否变了
4. **`dist/src/browser/bridge.js`** — 检查 BrowserBridge.connect 签名
5. **`clis/`** — 检查适配器是否有新增/变更

运行 `bun install` 后 `postinstall` 会自动重新应用 patch。如果 patch 失败（pattern 不匹配），手动检查 runtime.js 的变化。
