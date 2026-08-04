---
name: hub-browser-sitemap
description: 当用 hub browser 驱动站点且 sitemap 上下文可用、被要求使用、或需要避免盲导航时使用。指导 agent 惰性消费站点 sitemap 文件、选择适配器/浏览器回退路径、从 state 签名续读、标记 stale 条目，且永远不拿 sitemap 压过实时浏览器状态。
allowed-tools: Bash(hub:*), Read, Edit, Write, Grep
---

# hub-browser-sitemap

当 `hub browser <session> analyze` 提示站点有 sitemap、或用户要求使用站点 sitemap 时，用本 skill。

sitemap 是**先验知识，不是 ground truth**。它应该减少盲点，但绝不能覆盖实时浏览器状态。

---

## 消费循环（Consumption Loop）

1. 先跑（或复用）`hub browser <session> state` 知道当前页面。
2. 只读最小的相关 sitemap 文件：
   - `SITE.md` —— 站点级导向。
   - 匹配当前状态的 `pages/<page-id>.md` 一份。
   - 匹配用户目标的 `workflows/<task-id>.md` 一份。
   - `pitfalls.md` —— 只在被工作流挡住或警告时读。
3. 优先工作流的 **Best path**。如果它指名某个适配器命令（如 `hub twitter post`），先于裸浏览器操作用它。
4. 适配器不可用或失败时，用 **Fallback path** 的浏览器工作流。
5. 每次导航或状态变更动作后，刷新 `state` 并与工作流的 `state_signature` 对比。
6. 现实和 sitemap 冲突时，信现实，继续探测，并写本地 stale 笔记或 draft patch。
7. 如果某个动作的恢复步骤带 `adapter_health_update: <adapter> -> suspect|broken`，更新本地 overlay 里引用该适配器的工作流，让后面的 agent 直接走回退路径。

---

## 查找顺序（Lookup Order）

先读本地 overlay，再读仓库 seed：

```text
~/.hub/config/sites/<site>/sitemap/    # 本地 overlay
sitemaps/<site>/                       # 仓库 seed（repo 根）
```

本地文件以相同 stable id 覆盖全局文件。

不要把整个大 sitemap 读进上下文。目录很大时先列文件名，再只读你需要的 page/workflow。

---

## Trust Reality 规则

sitemap 说某按钮、URL、路由或 API 应该存在，但浏览器里没有：

- 用语义锚点重跑 `state` 或 `find`。
- 检查是否登录态、locale、viewport、A/B 测试或路由状态不同。
- 有安全路径可见就走真实页面。
- 在本地 overlay 里把该 sitemap 条目标记 stale。

永远不要因为“sitemap 说应该能行”就继续点。

---

## Stale / Draft 笔记

发现漂移时，在对应 page/workflow 文件下或本地 overlay 的 draft 文件里写一条小笔记：

```md
Stale note:
- observed_at: YYYY-MM-DD
- current_url:
- expected:
- actual:
- next_probe:
```

除非任务明确是 sitemap 撰写或仓库 PR 任务，否则不要改全局 seed 文件。

---

## 适配器健康写回（Adapter Health Write-Back）

适配器失败且 sitemap 的 action/workflow 要求更新适配器健康时：

1. 在 `~/.hub/config/sites/<site>/sitemap/workflows/` 下找到 `Best path` 引用该适配器命令的本地工作流文件。
2. 没有本地工作流就先复制匹配的全局工作流进本地 overlay——浏览器任务执行期间**永远不直接改全局 seed**。
3. 按指示把 `adapter_health` 设为 `suspect` 或 `broken`。
4. 加一条短 stale note：观察到的错误、当前 URL、时间戳。
5. 继续走浏览器回退路径。

这个写回就是记忆回路：当前 agent 只回退一次，下一个 agent 不会浪费一轮去重试已知可疑的适配器。

---

## 输出纪律（Output Discipline）

汇报时包含：

- 走的路径：适配器 best path 还是浏览器 fallback。
- 到达的检查点：当前 URL / state signature。
- Sitemap 健康度：原样使用、标记 stale、或缺失工作流。

报告聚焦任务。不要总结整份 sitemap。
