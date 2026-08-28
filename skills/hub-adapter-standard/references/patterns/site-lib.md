# 站点组件库分层规范(site lib/)—— 从单文件 shared.js 到分层模块树

> 实践来源:QuickBI 站点重构(2026-08-28)。3 报表 4 适配器,单文件 shared.js 长到
> 1857 行后按本规范拆为 lib/ 模块树,适配器从「import 16 个函数 + 本地 300 行组件
> 代码」变为「纯业务编排」(order-detail 651→约 280 行,tgo-detail 197 行不变)。

## 何时需要分层(升级阈值)

单文件 shared.js 是默认起点(见 `shared-js/overview.md` 模板)。出现以下信号再升级,
不要提前:

- **适配器 ≥3 个且 shared.js > 1000 行**——函数按「谁在用」已经分簇
- **同一组件出现两套实现**(如两套日期 fill、两套单选 fill)——说明缺一个归置点
- **纯函数(条件解析/行映射)与 page 操作纠缠**——想要 `bun test` 直跑的安全网
- **适配器里长出本应共享的本地组件函数**(下提时机到了)

## 目标结构

```
clis/<site>/
├── <adapter>.js ...          # 适配器留顶层(发现器只扫站点目录顶层 .js,见下)
└── lib/                      # 站点库(对发现器不可见)
    ├── index.js              # 唯一公共门面——适配器只 import 这一个文件
    ├── core/                 # ② 基础设施:知道 iframe/DOM 结构,不知道任何业务字段
    │   ├── site.js           #    HOST / IFRAME_SELECTOR / AUTH_COOKIE(站点级事实)
    │   ├── eval.js           #    iframe 上下文求值(dashEval)
    │   ├── anchor.js         #    锚点轮询(waitForAnchor)
    │   └── snapshot.js       #    AX 快照互证(第三断言面)
    ├── components/           # ③ 组件操作:一族组件一文件
    │   ├── fields.js         #    字段定位原语(fieldFinderJs)/字段发现/读值
    │   ├── <组件族>.js        #    advance-select / date-range / single-select / ...
    ├── lifecycle/            # ④ 页面生命周期
    │   ├── auth.js           #    登录态检查
    │   ├── dashboard.js      #    waitForDashboard(参数化)/ensurePageAlive(R3)
    │   ├── query.js          #    clickQueryButton / queryAndCaptureWithR3
    │   ├── table.js          #    waitForTableSettled(Node 侧分片轮询)
    │   └── reset.js          #    R2 面板复位(动态发现驱动)
    ├── data/                 # ⑤ 数据通道
    │   ├── capture.js        #    页面请求捕获(fetch 补丁 + CDP 双通道)
    │   ├── conditions.js     #    条件解析/断言(纯函数)
    │   ├── grid.js           #    响应行映射(纯函数,三种形态)
    │   ├── fetch.js          #    payload 重放分页取数
    │   └── download.js       #    下载武装
    └── util/                 # ① 零依赖工具:sleep / 日期纯函数 / 截图
```

**发现器机制(为什么 lib/ 安全)**:用户适配器发现器只 `readdir` 站点目录**顶层**
并 import 顶层 `.js`(排除 `.test.js`)。子目录对注册表完全不可见——lib/ 放多少
文件都不会被误当适配器加载;`~/.hub/package.json {type:module}` + node_modules
符号链接使 lib/ 内部相对 import 与 `@jackwener/opencli/*` 在任意深度正常解析,
`.test.js` 可被 `bun test` 直跑(纯函数模块)。

## 依赖规则(单向,禁止逆行)

```
适配器 → lib/index.js → {components, lifecycle, data} → core → util
components/lifecycle/data 互不横穿
例外:lifecycle/query → data/capture(查询即捕获);lifecycle/reset → components(复位即组件清空)
pure 模块(conditions/grid/util.date)零 page、零内部依赖
```

## 各层契约(签名形态 + 失败语义)

| 层 | 签名形态 | 失败语义 |
|---|---|---|
| core | `(page, ...) → 值` | eval 不判断对错;anchor 超时 throw(带最后观察态) |
| components | `(page, label, value) → {ok \| __err}` | **永不 throw**(重试/降级决策归编排方) |
| lifecycle | `(page, ...) → 就绪页面` | throw(页面级终态) |
| data 断言 | `(body, expected) → qp` | 断言失败 throw(契约终态) |
| pure | `值 → 值` | bun test 直跑,`.test.js` 紧邻模块 |

**参数化原则**:组件函数的 label 必须是参数(从调用方传入),报表级常量
(URL/menuId/字段 label/fid/列映射)一律留在适配器——「换报表不变」进 lib,
「换报表必变」归适配器。字段定位统一「精确等值优先,子串兜底」语义
(fieldFinderJs 原语,包含关系 label 陷阱见 keyword-select.md)。

## 归置判定准则

- 换**报表**还要用 → lib(站点组件库)
- 换**站点**还要用 → 暂留 lib;第二个站点真用时再上提 `clis/_shared/`(三次法则)
- 不碰 page 可测 → lib 的 pure 模块(必须配 `.test.js`)

## 迁移工作流(重建,不是打补丁)

1. **通读现状**:全量读旧 shared.js + 全部适配器,建函数清单与依赖图;找出
   死代码(无消费者的函数直接删,QuickBI 实例删了约 250 行)、重复实现
   (两套 fill 合一,强实现胜出)、适配器本地组件(上提)
2. **建 lib/ 树**:机械搬运为主,只做四类变更——参数化 label / 合并重复实现 /
   删死代码 / 修已知 bug(搬运中发现的存量 bug 要修并记录,如 quote R2 的
   `fillEnumMultiSelect(label, [])` no-op 调用)
3. **index.js 门面 + 适配器改 import 并瘦身**
4. **验证三层**:①`bun build` 全量语法/模块解析 ②`bun test` 纯函数单测
   ③每个适配器行为回归(重构前先跑一轮留基线;行为等价性以「同命令同输出」为准)
5. **删旧 shared.js + 同步镜像**

## 迁移实例数据(QuickBI)

| 项 | 旧 | 新 |
|---|---|---|
| 组织 | shared.js 1857 行单文件 | lib/ 22 文件(core 4 + components 9 + lifecycle 5 + data 5 + util 2 + index),单文件 20-400 行 |
| 死代码 | ~250 行(buildOlapQueryParam/fetchOlapRows/OLAP_FIELDS 等) | 删除 |
| 重复实现 | 两套日期 fill / 两套单选 fill / 两套条件断言 | 合一(强实现胜出,统一「精确优先子串兜底」定位) |
| order-detail.js | 651 行(含 6 个本地组件函数) | ~280 行(纯编排:COLUMN_MAP/字段例外/编排) |
| 纯函数单测 | 无 | 19 用例(conditions 12 + grid 7) |

## 陷阱

1. **行为回归被平台劣化挡住时,用旧代码跑对照**——旧代码同命令同失败 = 平台
   问题实锤,与重构无关;旧代码成功新代码失败才是回归。QuickBI 实例:重构当天
   平台全站枚举接口不返回数据,旧代码逐字复现同错,判定与重构零关系。
2. **搬运中发现的存量 bug 必须修,但要与「机械搬运」分开记录**——否则回归失败
   时分不清是搬运引入还是 bug 修复改变了行为。
3. **expr 字符串模板里的 `\n`**:JS 模板字符串中写 `\\n` 才能让页面端正则收到
   `\n` 转义;所有 dashEval 表达式拼进模板后必须实跑验证一次(语法错会立刻炸)。
4. **`waitForDashboard` 参数化**:三形态(URL/label/exact/reload/timeout)收敛为
   一个函数——渲染挂死报表传 `reload:false`(reload 对挂死无效,等够直接失败,
   错误消息把人工恢复手段告诉用户)。
