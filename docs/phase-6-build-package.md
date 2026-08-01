# Phase 6 — Chromium 构建 + 打包

> 状态：⬜ 未开始
> 预估：5-7 天
> 依赖：Phase 3 + Phase 5 完成

## 目标

用 BrowserClaw 的构建系统，把融合后的 Chromium patches 编译成可分发的浏览器 .app。

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
browseros source ensure --root ~/work/chromium --step checkout
# 这步会拉取 Chromium 148 的源码

# 安装依赖
browseros source ensure --root ~/work/chromium --step sync
# 这步安装 Chromium 构建需要的工具链
```

### 6.4 应用补丁

```bash
# 应用所有 BrowserClaw 补丁 + 我们的融合改动
browseros apply --chromium-src ~/work/chromium/src
```

这会把 `chromium_patches/` 里的所有补丁打到 Chromium 源码上，包括：
- BrowserClaw 原有补丁（server/CDP 域/品牌/onboarding 等）
- 我们 Phase 3 加的 TaskSpace CDP 域
- 我们 Phase 5 加的 Input 拦截

### 6.5 构建

```bash
# Release 构建
browseros build --preset release --chromium-src ~/work/chromium/src

# 调试构建（更快但更大）
browseros build --preset debug --chromium-src ~/work/chromium/src
```

构建参数：
- `--preset release|debug`：构建配置
- `--chromium-src`：Chromium 源码路径
- `--modules`：指定构建模块（setup/prep/build/sign/package/upload）
- 可以只跑部分阶段：`--modules build` 只编译

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
browseros source ensure --root <path>           # 拉取 Chromium 源码
browseros apply --chromium-src <path>           # 应用补丁
browseros build --preset <release|debug>         # 编译
browseros package --chromium-src <path>          # 打包
browseros sign --chromium-src <path>             # 签名
browseros dev --help                             # 开发用补丁管理
browseros release --help                         # 发布自动化
browseros ext --help                             # 扩展打包
browseros ota --help                             # OTA 更新
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

1. **内存不够**：M4 Pro 24GB 编译 Chromium 可能 OOM。解决：限制并行度 `browseros build -- -j4`
2. **编译时间过长**：首次 2-6 小时。增量编译会快很多（改一个文件只需几分钟）
3. **签名失败**：没有 Apple 开发者证书。解决：用 ad-hoc 签名 `codesign --force --deep --sign - BrowserOS.app`
4. **depot_tools 版本不匹配**：Chromium 148 需要特定版本的 depot_tools

## 验证标准

| 验证项 | 命令 | 预期结果 |
|---|---|---|
| 源码拉取 | `browseros source ensure` | 无报错 |
| 补丁应用 | `browseros apply` | 所有 features applied |
| 编译成功 | `browseros build` | 无编译错误 |
| .app 生成 | `browseros package` | 生成 BrowserOS.app |
| 启动 | `open -a BrowserOS` | 浏览器正常打开 |
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
- [ ] 统一 TS/JS 双份文件（见 6.9）

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

## 实际进展

（待填写）
