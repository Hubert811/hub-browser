# `hub browser verify` 30 秒子进程上限（慢站点）

## 问题现象

- `hub browser verify <site>/<cmd>` 报 `✗ Adapter failed. Fix the code and try again.`
- 但直接跑 `hub <site> <cmd>` 完全正常

## 根因

`verify` 用 `execFileSync` 执行适配器，**硬编码 30000ms 超时**（`src/opencli-engine/cli.js`）。慢站点冷加载 + 筛选 + 查询超过 30s 就被杀。

## 修复方案

1. **persistent 会话 + 热标签**：先跑一次适配器（把标签页留在已加载、已设好筛选的状态），紧接着跑 verify——幂等 + 跳过 reload 后实测 29s 通过。
2. 无法进 30s 时：以直接运行 + fixture 手工校验作为验收证据，并在覆盖报告里注明 verify 的 30s 限制。
3. 适配器声明 `timeout` 参数不会影响 verify 的 30s（那是 verify 自己的 execFileSync 上限）。

## 通用性

- 大报表、重异步、慢接口的 B 端站点

## 验证建议

- 预热后立即 verify，确认 <30s；记录实际耗时
- 冷/热两种状态下各跑一次，明确边界
