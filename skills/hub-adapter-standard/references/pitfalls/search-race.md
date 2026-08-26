# 可搜索下拉：搜索竞态与「暂无结果」瞬态误判

## 问题现象

- 搜索框里明明有词，但结果列表永不出现，弹层一直"加载中"
- 有时报"无结果"，但手动搜明明能搜到

## 根因

1. **搜索竞态**：弹层打开时正在加载初始值列表（显示"加载中"），此时立刻键入搜索词 → 搜索请求丢失/卡死。
2. **瞬态误判**：「暂无搜索内容」可能是搜索进行中的**瞬态**（debounce/DB 查询期间短暂显示），一见即判终态 → 假阴性。
3. React 受控输入只认真实键入：合成 input 事件不触发 onChange（需 CDP `Input.insertText`）。

## 修复方案

1. **键入前先等「弹层就绪」锚点**（"加载中"消失，初始列表已加载或出现空占位）。
2. 键入后等「搜索结果过滤渲染」锚点：**全部叶子项都含搜索词**（证明过滤完成），且"加载中"消失。
3. 「暂无搜索内容」不立即判终态：只有**持续无结果 + 输入框确实有搜索词**才算真无结果（轮询整个窗口）。

```javascript
// 锚点 A：搜索过滤完成（排除 加载中/占位文案，全部叶子项含搜索词）
const anchorA = `(() => {
  const popup = visiblePopup(d);
  const t = popup.innerText || "";
  if (t.includes('加载中')) return { ok: false, observed: t };
  const leaves = leafItems(popup);
  if (leaves.length > 0 && leaves.every(x => x.includes("战略"))) return { ok: true, items: leaves };
  return { ok: false, emptySeen: t.includes('暂无搜索内容') };
})()`;
```

## 通用性

- 所有可搜索下拉/级联选择（Element UI、AntD、自定义组件）
- 远程搜索（从数据库搜索）的组件尤其容易踩

## 验证建议

- 连续跑 5 次同一搜索，确认无偶发"无结果"
- 冷启动（刚打开弹层就搜）与热状态（弹层已打开）都要测
