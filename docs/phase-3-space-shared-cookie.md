# Phase 3 — 空间分配（共享 cookie）+ Agent 级 Tab 隔离

> 状态：✅ 完成（2026-08-03 收尾）
> 预估：5-8 天
> 依赖：Phase 2 完成（可与 Phase 4 并行）

## 目标

复刻 ego (lite) 的 Space（任务空间）功能，但**直接共享用户 cookie/存储**，不做 BrowserContext 物理隔离。每个 Space 是同一浏览器上下文内的**标签页集合 + 生命周期 + 归属控制**；Agent 在工具层只能看到、只能操作**自己拥有的 Space 的标签页**。

- **Layer 1（本阶段）**：内核 + 服务端 Agent 级 Tab 隔离 + `hub space` 命令。**纯客户端/服务端实现，不修改 `chromium_patches/`，不重新打包浏览器。**
- **Layer 2（延后）**：真物理隔离 → Phase 5.4；浏览器 GUI（按钮/侧栏/蒙层/控制条）→ Phase 7。

## 背景与决策记录

### 为什么共享 cookie

- **ego (lite) 当前 build（0.4.5.8）实测**：task space 与用户浏览共享同一个 cookie 库（`Default/Cookies`）和 localStorage（`Default/Local Storage/leveldb`）。space 之间、space 与用户之间的 cookie/localStorage 改动**互相可见**（有 SQLite 延迟落盘，但不是隔离）。CDP 查证：所有标签页（用户 + 各 space）的 `browserContextId` 相同，没有独立 BrowserContext。
- ego 官方文档声称"每个任务一个独立的 BrowserContext，cookie 与 storage 隔离"——**是设计意图，当前 build 未兑现**。
- 我们判断：**"创建时复制 + 不回写"的必要性不强**。登录态 99% 在 cookie；localStorage 只承载少量 auth token；IndexedDB 复制成本高收益低（且无变更通知，只能一次性复制）。共享 cookie 成本最低、登录态天然继承。
- **代价**：Agent 在 Space 里的 cookie/localStorage 改动会落到用户真实 profile（与 ego 现状一致）。文档/产品说明需明确这一点。

### Layer 1 / Layer 2 划分

| 层 | 内容 | 所在阶段 | 是否重新打包浏览器 |
|---|---|---|---|
| Layer 1 | TaskSpaceManager + 归属状态机 + 服务端 Agent 级 Tab 隔离 + `hub space` + 事件流 | **Phase 3（本阶段）** | 否 |
| Layer 2（安全） | 真物理隔离：独立 BrowserContext + CDP 暴露面收敛 + Target 域 session 过滤 | Phase 5.4（延后/可选） | 是 |
| Layer 2（GUI） | 右上角按钮 + 侧栏 space 列表 + agent 蒙层动画 + dock 控制条 | Phase 7 | 是 |


### 决策 D1 / D2（2026-08-02 定稿）

**D1 — TaskSpaceManager 放在统一 Core（hub-browser）**，不在 claw-server-rust。

- 6.10 统一完成后，MCP（`src/browser-mcp` fork）和 CLI（`hub.mjs`）都通过 UnifiedPage 操作页面——统一 Core 就是唯一操作入口。
- 账本（spaces / tab→space）、`SpaceOwnership` guard、space.* 事件全部放这里，天然单点，不再需要"服务端为事实来源 + 薄代理"的折中。
- claw-server-rust + Rust `browseros-mcp` 是另一条独立工具面（BrowserClaw 原生面）。融合产品若以 TS fork 为 Agent 入口，该面本阶段不做空间功能；确认产品最终用哪条面是 Phase 3 开工前的收尾项（见 3.0 注）。

**D2 — space 与 conversation 1:N**（一个会话可拥有多个 space；每个 space 一个时刻只有一个 owner）。

- space 独立身份（uuid），owner 为某个 conversation；ownership（agent / agentDelegatedToUser / user）独占式交接，不是共享。
- 会话级维护 `current_space_id`，`switch(spaceId)` 切换当前空间；`useOrCreateTaskSpace(name)` 按 `(owner, name)` 复用或新建。
- 与 ego 语义逐条对齐（createTaskSpace / listTaskSpaces / useTaskSpace / claimTaskSpace / handOff / takeOver），不引入多 agent 并发持有同一 space 的复杂度。
- 将来若升级为多 agent 共享（N:M），只需在 ownership 上加多 viewer 语义，表结构不推翻。

## 概念定义

```
Space = 标签页集合 (tabIds)
      + 生命周期 (create/close/complete)
      + 归属控制 (agent / agentDelegatedToUser / user)
      + 任务名 (taskId)
      —— 运行在默认 BrowserContext 里，cookie/localStorage 与用户共享 ——
```

## 架构

```
┌────────────────────────────────────────────────────────────┐
│  Agent（MCP / CLI）                                        │
│   └─ hub space / tabs 等工具（统一 Core 按归属过滤）        │
├────────────────────────────────────────────────────────────┤
│  统一 Core（hub-browser，TS）                              │
│   • TaskSpaceManager 状态（spaces 存储 + tab→space 账本）    │
│   • SpaceOwnership guard（tabs 过滤 + 控制工具校验）         │
│   • tab group 按 space 分组着色（fork tab-groups 工具）       │
│   • space.* 事件流                                          │
│   • MCP 工具 = src/browser-mcp（fork，统一后 Agent 入口）     │
├────────────────────────────────────────────────────────────┤
│  Chromium fork（浏览器进程；本阶段零改动）                    │
│   • 默认 BrowserContext（共享 cookie/localStorage）          │
│   • 原生 tab group / Target.createTarget（background 开页）  │
└────────────────────────────────────────────────────────────┘

注：claw-server-rust + Rust browseros-mcp 是独立工具面（BrowserClaw 原生 MCP），本阶段不动。
```

## 数据模型

```typescript
interface TaskSpace {
  id: string
  name: string
  taskId: string
  ownership: 'agent' | 'agentDelegatedToUser' | 'user'
  tabIds: string[]          // 页面 targetId；浏览器重启后失效
  createdAt: number
  lastActiveAt: number
  keepOnComplete?: boolean
  storageMode: 'shared'     // 预留：将来启用真隔离时可加 'isolated'
}
```

持久化：统一 Core 侧新增 `spaces` 存储 + `tab→space` 映射（表结构参考 claw-server 的 `session_tabs`；hub-browser 用 SQLite/JSON 均可，未来跨进程共享时再并入服务端库）。
**浏览器重启后 targetId 全部失效** → 恢复（restore）按 URL 重开，不存 targetId。

## 实现步骤

### 3.0 复用盘点（统一 Core 侧已有能力）

| 已有部件 | 位置 | 复用方式 |
|---|---|---|
| fork 工具注册 | `src/browser-mcp/src/tools/registry.ts` | 加 `space.*` 工具；`tabs` 按归属过滤 |
| 工具上下文 | `src/browser-mcp/src/tools/framework.ts`（ToolContext） | 加 identity（session/agent）+ current_space |
| 页面操作单点 | `src/page.ts`（UnifiedPage）+ `src/factory.ts` | SpaceOwnership guard 包这一层 |
| 页面/账本接口 | `@browseros/browser-core`（pages/session） | 账本结构参考其 session_tabs 模式 |
| tab group 工具 | fork `tab-groups.ts`（走 UnifiedPage tabGroup*） | 按 space 分组着色 |

> 注：claw-server-rust 的 `session_tabs` / `tab_ownership.rs` / `effects/tab_groups.rs` 属于 Rust 工具面。融合产品若以 TS fork 为 Agent 入口，本阶段不依赖它们；若两条面都保留，需分别在两条面上实现，或统一入口后废弃。

### 3.1 TaskSpaceManager（统一 Core）

```typescript
create(name, taskId?) -> Space         // 只分配 id，不调用浏览器
openTab(spaceId, url, {background:true}) -> pageId  // Target.createTarget，后台开页不抢焦点
listTabs(spaceId) -> PageInfo[]        // 按账本过滤（外部关闭的标签自动剔除）
closeTab(spaceId, pageId)              // Target.closeTarget + 账本清理
closeSpace(spaceId, {keep})            // keep=false 逐个关闭全部标签；user 持有的空间先 claim
switch(spaceId)                        // 切换当前空间，影响后续 IPage 操作目标
restore()                              // 重启后按 URL 重开空间标签页
```

关键 CDP 细节：
- `Target.createTarget { url, background: true }`：后台开页，实现 ego 承诺的"Agent 操作不打断用户"。
- 监听 `Target.targetDestroyed`：用户/agent 手动关标签时自动从 space.tabIds 清理。
- **不逐 space 开独立窗口**：CDP 没有跨窗口移动 tab 的 API，单窗口 + background tabs 最接近 ego。

### 3.2 归属状态机（控制权交接）

```
agent → (handOff) → agentDelegatedToUser → (用户确认) → user
user → (takeOver) → agent（需要用户确认）
```

- `ownership = user` 时，Agent 的所有 IPage 操作抛错 **"user is controlling"**，必须等用户确认才能继续。
- 保留 ego 语义：user 持有的 space，agent `close` 需先 claim 再关。

### 3.3 Agent 级 Tab 隔离（统一 Core，本阶段重点）

- `tabs list`：`pages.list()` 之后按"当前 agent 拥有的 space"过滤——agent 只能看到自己 space 的标签页。
- 所有控制工具（act/navigate/read/screenshot/evaluate/run…）执行前校验 `page ∈ 该 agent 的 space`，否则拒绝（"page not in your space"）。
- MCP 工具注解 `open_world_annotations` 收窄为 per-space 范围，避免 LLM 得知其他空间存在。
- ⚠️ 这是 **API 策略级隔离**（对走 MCP 的正常 agent 有效）。能摸到 raw CDP（调试端口）的 agent 可绕过；真隔离见 Phase 5.4。

### 3.4 `hub space` 命令组

```bash
hub space create "搜索任务"     # → space id
hub space list                 # ID | Name | Status | Tabs | Created
hub space switch <id>
hub space close <id> [--keep]
hub space handoff <id>
hub space takeover <id>
hub space current
hub space refresh <id>         # = MCP space.recycle：重开全部 tab
```

实现：`src/opencli-engine/cli.js` 内联注册 → 调 TaskSpaceManager（**不走自定义 CDP 域**，Phase 3 不新增 CDP 域）。D4 后命令名统一为 `hub space`（无 `use`/`claim` CLI 等价，对应 MCP `space.use`/`space.claim`）。

### 3.5 事件流

`space.created / space.agent_active / space.handoff_requested / space.interrupted / space.closed`
通过 MCP notification / server 事件总线推送；Phase 7 的 GUI 和 Agent 端提示都订阅它。

## 本阶段不做（延后）

- BrowserContext 物理隔离、Cookie/LocalStorage/IndexedDB 三层复制、Chromium CDP 域扩展 → 见附录 A，评估入口在 Phase 5.4
- 浏览器 GUI（右上角按钮/侧栏/蒙层/控制条）→ Phase 7
- **不修改 `chromium_patches/`，不重新打包浏览器**

## 验证标准

| 验证项 | 命令 | 预期结果 |
|---|---|---|
| 创建空间 | `hub space create "test"` | 返回 space id |
| 共享 cookie | 空间内访问需登录网站 | 直接已登录（与用户 profile 一致） |
| 共享 localStorage | 空间内写 localStorage | 用户 profile 可见（反之亦然） |
| Agent 隔离 | agent A 执行 `tabs` | 只看到自己 space 的标签 |
| 越权拒绝 | agent A 操作 B 的 pageId | 报 "page not in your space" |
| 空间内操作 | `hub browser <session> state` | 操作在当前空间内 |
| 关闭空间 | `hub space close <id>` | 所有 Tab 关闭，账本清理 |
| 控制权交接 | `hub space handoff <id>` | Agent 操作被拒绝 |
| 接管 | `hub space takeover <id>` | Agent 恢复操作 |

## 完成标志

- [x] TaskSpaceManager（create/openTab/listTabs/close/switch/restore/current/handoff/takeover）✅
- [x] `SpaceOwnership` guard + `tabs` 过滤 + 控制工具校验（D3：无 space 拒绝）✅
- [x] 适配器命令绑定 space（execution.js）✅
- [x] `hub browser *` 接入 D3（D4）✅
- [x] space ↔ tab group 双向同步（D5）✅
- [x] `~/.hub` 用户数据目录迁移（方案 C）✅
- [x] 双身份/多 agent 隔离验证 + 完整回归（268 单测 + 6 live 冒烟）✅
- [x] space → tab group 自动分组着色 ✅（D5 TS 侧：`Browser.createTabGroup` + `deterministicColor(spaceId)`；`tab_groups.rs` 是 BrowserClaw 原生 Rust 面，本阶段不涉及）
- [x] `hub space` 命令组 ✅（create/list/switch/close/handoff/takeover/current/refresh，2026-08-03）
- [x] space.* 事件流 ✅（MCP notifications：`space.created` / `space.handoff_requested` / `space.tabs_recycled` 等）
- [x] 共享 cookie 验证 + Agent 级隔离验证 + 交接验证 ✅（两轮 E2E + 268 单测 + 6 live 冒烟）

## 实际进展

**状态：✅ 完成（2026-08-03 收尾）**

### 已完成交付
- **D1/D2**：TaskSpaceManager 放统一 Core（`src/space/task-space-manager.ts`）；space 与 conversation 1:N。
- **D3**：space 是 agent 操作 tab 的前提——无 space 时 `tabs list` 空、页面控制工具/适配器命令/`hub browser *` 全拒绝（`no-space`）；有 space 才可操作。适配器命令绑定到 space 的 tab（`execution.js bindAdapterPageToSpace`）。
- **D4**：`hub browser *` 命令组接入 D3（无 space 拒绝/空）；用户可见文本 opencli→hub。
- **D5**：space ↔ tab group 双向同步（lazy reconcile）——自动建组（title=space 名+确定性色）、人类拖入归属/拖出移除、改名不反写、组删重建、close 关组。
- **方案 C**：用户数据目录 `~/.opencli` → `~/.hub`（config/cache/state/clis 分层），一次性迁移 hub-spaces.json + 用户适配器。

### 测试与修复
- 第一轮适配器×space E2E：发现 12 个 bug（适配器不归 space、daemon 身份坍缩、tab guard 缺失、URL 失真、close 残留等），**已修 10 个**（高/中优先级），详见 `adapter-space-e2e-results.md`。
- UA override 指纹修复（`src/opencli/ua-override.ts`）：补全 Google Chrome brand + 真实 high-entropy（platformVersion/architecture 从 live 读取，不再硬编码）。
- 第二轮免登录站点全量测试：23 站点/40 命令，16 全过、2 偶发、5 站点侧失败（booking/google-scholar/huodongxing/uisdc/youdao，非 space 问题）；D3/D5 组合 22/22 通过。
- 竞态修复：sync「拖出移除」不再误删 `restored:false` 未入组新 tab。
- 完整回归：单测 **268 pass / 0 fail**、typecheck 0 error、6 项 live 冒烟全过、D3/D5 组合验证通过。

### 已知边界
- CLI `hub browser <session> *` 已接入 D3（无 space 拒绝/空）。
- 真物理隔离（Phase 5.4）延后/可选；共享 cookie 是本阶段明确接受的设计（与 ego 现状一致）。

---

## 附录 A：物理隔离 + 存储复制方案（已延后）

> 原 Phase 3 方案（10-15 天），因"必要性不强 + 成本高（IndexedDB 复制复杂）"延后。
> 若 Phase 5.4（真隔离）或产品需求决定启用，回到此方案；其中 Cookie 复制（第一层）成本低，可独立启用。

### 原方案目标

把 Space 改成 **BrowserContext 物理隔离**：每个 Task Space 拥有独立浏览上下文，从用户 profile 复制登录态，互不干扰。

### 原方案：存储复制三层

**第一层：Cookie 复制（成本低，唯一真正必要的部分）**

```typescript
async function copyCookies(fromContext: string, toContext: string) {
  const cookies = await cdp('Storage.getCookies', { browserContextId: fromContext })
  for (const cookie of cookies) {
    await cdp('Network.setCookie', { ...cookie, browserContextId: toContext })
  }
}
```

**第二层：LocalStorage 复制（成本中，需 per-origin 执行，无增量同步）**

```typescript
async function copyLocalStorage(fromPage: IPage, toPage: IPage) {
  const data = await fromPage.evaluate(`JSON.stringify({...localStorage})`)
  const entries = JSON.parse(data)
  await toPage.evaluate(`(() => {
    for (const [k, v] of Object.entries(${JSON.stringify(entries)})) localStorage.setItem(k, String(v))
  })()`)
}
```

**第三层：IndexedDB 复制（成本最高，受同源策略限制，可能需要 Chromium C++ 补丁 `StoragePartitionImpl` 层）**

```typescript
async function copyIndexedDB(fromPage: IPage, toPage: IPage) {
  // 枚举数据库 → 逐库逐 object store 复制
  // 若 JS 方案不可行 → C++ 存储分区复制补丁（+3-5 天）
}
```

### 原方案：Chromium CDP 域扩展（需重新打包）

```
Target.pdl 新增:
  createTaskSpace (parentContextId?) -> contextId + initialTargetId
  closeTaskSpace (contextId)
  listTaskSpaces -> TaskSpaceInfo[]
实现: content/browser/devtools/protocol/target_handler.cc + storage_partition_impl.cc
```

### 原方案的结论沉淀

- **创建时复制 + 不回写** 是正确模型，但只在需要"隔离 + 继承登录态"时才值得做。
- 登录态 99% 在 cookie，第一层足以覆盖绝大多数站点；localStorage 按需；IndexedDB 不建议现在做。
- 与共享 cookie 方案（本 Phase 3）的取舍：共享方案零成本但 agent 改动污染用户；隔离方案保用户但失去天然继承（创建后中途用户重新登录，space 内快照会过期，需重新同步）。

---

## 附录 B：Tab 生命周期与新鲜度设计（2026-08-03）

> 背景：排查确认 BrowserClaw/Chromium 的 `Page.captureScreenshot` 会**按标签**随机性地永久卡死（标签被反复导航 + Input + AX 快照累积后），reload 不恢复，新标签永远正常。下面把 tab 生命周期做成显式设计，目标是"标签始终可用（新鲜）"，同时最小化页面状态丢失。

### 现状生命周期（已实现）

```
创建：space.open_tab(url) → browser.newPage → ledger TabRef{ pageId, url, restored:false }
使用：任务期间持续操作同一标签（无新鲜度管理）
结束：closeSpace(keep:false) 关全部标签 / closeTab 关单个
重启：restore() 按 URL 重开 pending 标签、重挂漂移标签
```

缺口：**任务中途没有"标签健康"概念**——一个标签被长期使用后可能楔死，截图/部分操作失败，agent 没有明确指引。

### 设计目标

1. 截图/页面操作**永远可用**：任一标签楔死时，agent 能快速识别并换新标签继续。
2. **最小化状态丢失**：不盲回收；只在楔死或任务边界换标签。
3. 可理解、可恢复：错误信息明确说"开新标签"。

### 修正版机制（2026-08-03，已落地，默认保守）

> 官方调研收敛：ego/BrowserClaw 都是多 tab 模型，**都没有基于新鲜度的自动回收**；
> 官方回收点 = 任务/会话边界（ego `completeTaskSpace(keep:false)`；BrowserClaw session
> 结束折叠、retention 到期关整组）。URL 复用（ego `openOrReuseTab`）**已实现**：
> `space.open_tab` 默认 exact 复用、`openTabWithReuse` 支持 origin/origin+path/includes/false。
> 因此本附录不再做"三层机制"，改为：**canary 兜底探测 + space 整组回收原语 + 最小遥测**，
> 全部默认保守（不自动杀 tab）。

**① canary 兜底探测（已实现，2026-08-03）**
- 根因：BrowserClaw/Chromium 的 `Page.captureScreenshot` 会**按标签**随机性永久楔死
  （标签累积操作后）；`Runtime.evaluate` 探测无效（主线程正常，卡的是 capture 管线）；
  **16×16 小 clip 截图能直接探测 capture 管线**（楔死时同样超时，正常时几 ms）。
- `UnifiedPage.canaryCapture(timeoutMs=2500)`：`Page.captureScreenshot` 带
  `clip:{x:0,y:0,width:16,height:16}`（jpeg），返回毫秒耗时或抛错；超时置
  `_screenshotWedged = true`（复用 `isScreenshotWedged()`）。
- MCP `screenshot` 工具：截图**前**先做一次 canary（默认开，`canary:false` 可关）。
  结果分档：
  - canary 成功 → 正常截图；
  - canary 超时 → 置 wedged 标记，按 `onWedged` 处理：
    - `'hint'`（**默认**）→ 返回明确错误（含 `[hint: tab-wedged -> open a fresh tab via space.open_tab or tabs new]`）；
    - `'auto-recycle'`（**opt-in**）→ ctx 能拿到 spaces/identity/gateway 时自动调
      `space.recycle` 换同 URL 新 tab 后**重试一次**截图；拿不到（无 wiring / 页不在
      space / recycle 失败）退回 `'hint'`。触发条件：canary 超时 + 显式 `onWedged:'auto-recycle'`
      + 该页属于某 task space。
- 换页绑定点（selectTab/newTab/closeTab 回退/setActivePage）自动清零 wedged 标记（既有）。

**② space 整组回收原语（已实现，2026-08-03）**
- `TaskSpaceManager.recycleSpaceTabs(owner, spaceId, gateway?)`：关闭 space 内全部存活 tab，
  再按各自 URL 用 `openTabWithReuse`（reuse:'exact' 语义，旧 tab 已关所以必然新建；
  同 URL 重复项强制新建以保持 tab 数）重开；ledger 更新为新 pageId（URL/标题保留）；
  发 `space.tabs_recycled` 事件（带 spaceId + urls 数）。返回 `{ recycled, tabs:[{oldPageId,newPageId,url,reused}], failed? }`。
  要求：owner 校验 + 非 user 持有（`assertAgentCanAct`）；space 记录
  （id/name/taskId/ownership/createdAt）不变，只换 tab。
- MCP 工具 `space.recycle`（spaceId 缺省 = 当前 space；`reuse` 不用传，整组重开）。
- CLI `hub space refresh <id>`（走 daemon manager / BrowserBridge 网关）。
- **边界挂钩（保守）**：不自动调 recycle；文档/工具描述明确——
  **新任务 = 新建 space（默认新标签）；长任务中途可用 `space.recycle` 整组刷新；
  任务结束 `closeSpace(keep:false)` 清理**。`useOrCreateTaskSpace` **不**自动回收
  复用到的旧 space（保留状态，符合官方）。

**③ 健康遥测（已实现，最小，先观测后定阈值）**
- manager 内存态记录每个 TabRef 的 `ops`（openTabWithReuse 命中/新建 +1；closeTab/recycle 清零）
  与 `ageMs`（打开时间戳）。**不持久化**（ledger 结构不动）、**不做自动决策**。
- `space.list_tabs` 结构化输出带 `ops/ageMs`（可选字段，帮助未来调阈值）。
- 阈值（N 分钟 / M 次操作自动回收）**未定**——先观测，后续再在安全点接入。

### 生命周期规则（汇总）

| 阶段 | 行为 |
|---|---|
| 创建 | `space.open_tab(url)` → ledger；每任务默认新标签（新 space） |
| 长任务 | 持续用同一标签；canary 超时 / `isScreenshotWedged()` → 默认返回 hint，agent 换新标签（同 URL）；opt-in `onWedged:'auto-recycle'` 自动整组刷新 |
| 中途刷新 | `space.recycle` / `hub space refresh <id>` 整组关旧开新（同 URL、新 pageId、事件 + 遥测重置） |
| 边界 | 新任务 = 新建 space；`useOrCreateTaskSpace` 复用旧 space 但不自动回收 |
| 结束 | `closeSpace(keep:false)` 关全部标签，账本清理 |
| 重启 | `restore()` 按 URL 重开 pending、重挂存活标签 |
| 测试 | 每轮用新标签 + 结束时关闭（已落地） |

### Ledger 兼容

- TabRef 已含 `url`，换标签 = 新 pageId + 同 url + `restored:false`，restore 下一次 reconcile 处理，无需改结构。
- wedge 标记是 UnifiedPage 实例态（非持久化），换页即清零。
- 遥测是 manager 内存态（`tabHealth` Map），不进 ledger、不持久化；restore 重开的标签
  无统计直到下一次 openTabWithReuse 命中/新建（`list_tabs` 的 ops/ageMs 可选、可缺省）。

### 已落地清单（2026-08-03）

1. `UnifiedPage.canaryCapture()` + `screenshot` 工具前置 canary（默认开）+ `onWedged`（默认 'hint'）。
2. `TaskSpaceManager.recycleSpaceTabs()` + MCP `space.recycle` + CLI `space refresh` + `space.tabs_recycled` 事件/通知。
3. `space.list_tabs` 结构化输出 `ops/ageMs`（内存遥测）。
4. 单测 + 真实 CDP 冒烟（见实现提交的测试与 smoke）。

## 决策 D3（2026-08-03 定稿）：space 是 agent 操作 tab 的前提（强制前置）

**模型**：`space 是前提 → tab group 是 space 的 UI 体现 → tab 必须属于某个 space 才能被 agent 操作`。

**目标语义（agent 视角）**：
- agent 没有任何 space → `tabs list` 返回空、控制工具（act/navigate/read/snapshot/…）对任何 page 拒绝、适配器命令拒绝执行或提示先建 space——**不再是 legacy 开放世界**。
- agent 拥有 ≥1 个 space → 只能操作自己 space 的 tab（现有 guard 已实现，保持不变）。

**现状与差距**：当前 `isolationActive()` 是「有 space 才隔离、无 space 走 legacy 全放开」——与目标不一致，需反转。

**改动面（三处）**：
1. `src/space/task-space-manager.ts` `assertPageControllable` / `assertCurrentSpaceAgentControllable`：无 space 时不再放行，改为抛 "no space; create one first"（错误码如 `no-space`）。
2. `src/browser-mcp/src/tools/framework.ts` / `registry.ts` `tabs list`：无 space 时返回空列表（删除 legacy 全列表路径）。
3. `src/opencli-engine/execution.js` 适配器绑定：无当前 space 时拒绝执行适配器命令（提示先 `opencli space create`），不再 fallback 到 legacy 激活 tab；错误明确、exit code 可预期。
   - ⚠️ 行为破坏性变更：`hub <site> <command>` 在未建 space 时将从"照常执行"变为"要求先建 space"。这是刻意的（与 ego 模型一致：agent 操作都在 task space 内）。
   - 兼容路径：**MCP/daemon 启动时若 owner 无 space，不自动建**（保持显式）；提供 `space create` 作为唯一前置。

**测试影响**：现有测试断言 legacy 放行（`isolationActive` 返回 false 时 `assertPageControllable` 通过）需更新为「无 space → 拒绝」；新增用例覆盖三处新行为。

**tab group 定位（与本决策的关系）**：tab group 是 space 的**呈现层**（Phase 7 UI：按 space 命名 + 确定性着色 + 自动同步），不承载权限；权限只由 space 归属 guard 决定。`openTabWithReuse` 已预留 `tabGroupId` 透传，Phase 7 接线自动建/同步 tab group。

**决策边界修正（2026-08-03）**：CLI `browser <session> *` 命令组（src/opencli-engine/cli.js L1018-1115）**底层已是 hub-browser 代码**（`browser/index.js` 中 `BrowserBridge = UnifiedBrowserFactory`，bind/unbind 显式禁用，走 UnifiedPage 与 MCP 同一套）——命令组外壳继承自 opencli fork 故名字仍为 `browser`。它属于「我们的代码」，**并纳入 D3 收紧**（2026-08-03 补充决策）：`browser open/tab list/tab select/tab close` 等命令无 current space 时拒绝/空列表（与 MCP/适配器路径一致），同时用户可见 help/错误文本中的 `opencli` 字样改为 `hub`。D3 管控：MCP space 工具 + 页面控制工具 + 适配器命令（execution.js）+ TaskSpaceManager guard。identity 缺失上下文（未识别 agent）保持开放世界亦为有意设计。

## 决策 D4（2026-08-03 补充）：browser 命令纳入 D3 + 用户文本改 hub

1. **browser 命令接 D3**：`opencli browser <session> open/tab list/tab select/tab close`（以及 openIntoCurrentSpace/scopeTabsToCurrentSpace/assertTabInCurrentSpace 路径）无 current space 时——open 拒绝（提示先建 space）、tab list 返回空、select/close 拒绝。与 MCP/适配器路径一致。
2. **用户可见文本 opencli → hub**：help 大标题/Usage、错误消息、提示（如 "run 'opencli space create'" → "run 'hub space create'"、"opencli browser ..." → "hub browser ..."）。**只改用户可见字符串**，不动包名 `@jackwener/opencli`、文件路径、`.opencli` 目录、registry 内部标识等代码/数据标识。

## 决策 D5（2026-08-03）：space ↔ tab group 双向同步（第一版）

**模型**：tab group 是 space 的呈现层 + 归属边界。space 是权威账本，tab group 是其投影；反向同步采用 **lazy reconcile**（非事件监听）。

### 正向：space → tab group（自动接线）
- space 首个 tab 创建时：`Browser.createTabGroup`，title=space 名、color=`deterministicColor(spaceId)`；`SpaceRecord` 增 `tabGroupId?: string` 持久化。
- 该 space 后续新 tab：`Browser.addTabsToGroup` 自动入组。
- `space close`：`Browser.closeTabGroup` 关组（连 tab 一起，已有语义）。
- restore/重启：group 没了则按账本重建（幂等 ensure）。

### 反向：人类改 tab group → space（lazy reconcile）
- 新增方法 `syncWithTabGroups()`：读 `getTabGroups()` + `listTabs()`，与账本 diff：
  1. **group 内新增 tab**（人类拖入/新建进组）→ 归属该 space（反查 tabId→pageId 写账本）——"视觉边界=归属边界"。
  2. **账本 tab 不在任何 group**（人类拖出）→ 从账本移除（与关 tab 同处理）。
  3. **人类改 group 名/色** → 不反写 space 名（尊重用户呈现）。
  4. **group 被删** → 下次操作自动重建（tab 保留）。
  5. **tab 关闭** → 账本 prune（已有 listTabs live reconcile 保留）。
- 触发点：`space list/current/tabs`、`openTab/openTabWithReuse`、guard 查询前 **lazy 调用**（低成本的 getTabs+getGroups diff）。
- **不做**事件级实时推送（留 Phase 7 UI 一并做）。

### 已确认决策（2026-08-03）
1. 拖入 group 的 tab 归属 space（视觉边界=归属边界；agent 只能操作自己 space，安全性不变）。
2. 人类改 group 名不反写 space 名。
3. 第一版 lazy reconcile，不做事件监听。

### 实现面
- `src/space/task-space-manager.ts`：`SpaceRecord.tabGroupId`；`SpaceTabGateway` 增 tabGroup 方法族；`ensureSpaceGroup()`/`syncWithTabGroups()`；openTab 自动入组、close 关组、restore 重建；触发点接线。
- `src/page.ts`：补 `addTabsToGroup(pages, groupId)`（走 `Browser.addTabsToGroup`）；gatewayFromPage/gatewayFromProvider 透传 tabGroup 方法。
- 测试：正向（建组/入组/close 关组）、反向（拖入归属/拖出移除/改名不反写/组删重建/关 tab prune）、lazy 触发。

---

## 决策 D8（2026-08-04）：遗留 space 自动回收（TTL 统一方案）

**问题**：agent 未显式 `space close` 的 space 永久留在账本，tab 越积越多；死 owner / 空 space 无任何回收机制（现状证据：`mcp-smoke-*` 空 space 一直挂在账本）。多轮方案讨论后收敛为：**统一 TTL 超时回收**——不做连接级（MCP EOF）回收、不做线程池、不引入常驻 daemon。

### 模型
- 判断标准只有一个：`SpaceRecord.lastActiveAt`（最后活动时间）超时。
- 两类过期：
  - **Tier 1 空 space**：`tabs: []` 且 `lastActiveAt` 超过 `HUB_SPACE_EMPTY_TTL_MS`（默认 24h）→ 删账本（无 tab 可关）。
  - **Tier 2 闲置 space**：`ownership === 'agent'` 且 `lastActiveAt` 超过 `HUB_SPACE_TTL_MS`（默认 7d）→ 账本驱逐 + best-effort 关 tab / 关组。
- **user-held（handoff 过）永不自动回收**；`lastActiveAt` 缺失的旧数据保守跳过（不回收）。

### 执行点（load-time 为主 + 长驻进程 timer 兜底）
- **manager 构造时同步驱逐账本**：CLI 每条命令 / daemon 启动 / MCP 启动都会 `new TaskSpaceManager` → 等价"每次操作前清"；**只在真正驱逐了东西时才写盘**。
- **关 tab 是异步 best-effort**：有 gateway（MCP / daemon 构造带 gateway）则后台 fire-and-forget 关；无 gateway（CLI 无浏览器上下文）跳过——账本已干净，tab 变普通浏览器 tab，用户可见可手动关。
- **MCP 长驻进程加定时器**：`HUB_SPACE_REAP_INTERVAL_MS`（默认 5min）周期调 `reapExpiredSpaces()`，兜底清"别的 agent 留下的 stale"。daemon 不额外加（其命令路径已覆盖）。
- **顺序铁律**：sweep 先于 restore —— restore 只恢复还活着的 space，被驱逐的不复活。

### 必修 bug（否则 TTL 永不触发）
- `restore()` 原来**无条件给所有 agent space 刷 `lastActiveAt`**——每次 daemon/MCP 启动都给 stale space"续命"。改为**只有该 space 本轮真的发生 reconcile（重新挂接 / 重开 / 修剪）才刷**；完全没动过的不刷（`restoredAt` 保持每次更新，信息性，不参与 TTL）。

### 配置
| 环境变量 | 默认 | 说明 |
|---|---|---|
| `HUB_SPACE_REAP` | `on` | `off` 关闭全部自动回收 |
| `HUB_SPACE_EMPTY_TTL_MS` | `86400000`（24h） | Tier 1 空 space |
| `HUB_SPACE_TTL_MS` | `604800000`（7d） | Tier 2 闲置 space |
| `HUB_SPACE_REAP_INTERVAL_MS` | `300000`（5min） | MCP 长驻进程定时器间隔 |

### 安全边界
- **账本驱逐是权威且立即的**（space 从账本消失 → restore 不复活 → tombstone 防跨进程复活）；关 tab 是 best-effort，浏览器不可达不阻塞任何回收（不会"连不上就永远推迟"）。
- 每次 evict 打日志（space id / name / tier / age / owner / tabs），可观测，喂未来遥测定阈值。
- 误杀风险低：在操作的 agent `lastActiveAt` 持续刷新；静止 7 天基本可断定废弃。
- 选项级覆盖 `TaskSpaceManagerOptions.reap`（测试用），env 与 options 均可关。

### 实现面
- `src/space/task-space-manager.ts`：`reapExpiredSpaces(gateway?)`（同步驱逐 + 异步关 tab）、构造时调用、`restore()` lastActiveAt 修复、env/options 读取。
- `bin/hub.mjs`：MCP 模式定时器（unref）。
- 测试：Tier1/Tier2 判定、user-held 豁免、lastActiveAt 缺失跳过、`HUB_SPACE_REAP=off`、构造时驱逐、驱逐清指针 + tombstone、只驱逐才写盘、restore 不再续命、异步关 tab best-effort。
