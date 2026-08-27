# 关键词搜索范式(Keyword Select)

> 来源:QuickBI order-detail 攻坚(2026-08-27,用户定调)。适用于**enum 多选大列表字段**
> (字段值成百上千条,弹层带搜索框与「添加左侧全部字段值」按钮的形态)。
> 这是该类字段的**默认范式**——逐值精确 pick 路线已废弃。

## 语义定调

**「搜索词 = 过滤器,结果集 = 选择集」**:

- 用户传入的关键词就是过滤意图,适配器搜关键词 → 把**全部匹配项**一次加选
- 想精确匹配某个值,把关键词写全即可——精确度控制权交给用户
- 搜索结果可能截断/分页,「添加左侧全部字段值」一次性全加,不漏不挑

### 为什么逐值精确 pick 必须废弃

order-detail 实证(2026-08-27):用户传「成都万科物业服务有限公司」,组件搜索是
**子串匹配**,唯一真实选项是「成都万科物业服务有限公司娇子台物业管理分公司」——
精确等值 pick 找不到目标,要么 no-option 失败,要么(旧实现缺陷)误勾错误项。
值为长名/互为前缀的场景,精确匹配天然失配;而全选匹配集才是搜索意图的完整表达。

## 实现链(QuickBI fillEnumKeywordSelect 实测,5s 全绿)

```
1. 开弹层:箭头 icon 触发(.advance-select-right-icon;有值态点 tag 不开)
   + 字段定位精确 label 优先、子串兜底(包含关系 label 陷阱)
2. 就绪锚点:懒加载大列表(「默认展示前1000条」)初始列表不可信
   → 就绪条件降为「搜索框可用」,反正要走搜索
3. 清残留:「已添加(N)」N>0 先点「清空」——残留 ∪ 搜索结果语义错
4. 输入关键词:eval 内 focus()+select()+execCommand('insertText')
   ——同一 eval 完成,跨 eval 分步焦点丢失(见下)
5. 结果锚点:列表项**全部含关键词**(高亮拆分形态下 leaf 是关键词片段,天然满足)
   或「暂无搜索内容」终态(且 inputVal 确为关键词——输入没生效不算无结果)
6. 加选:点「添加左侧全部字段值」;无此按钮 → 手动全选(行级去重,见陷阱)
7. 勾选证据锚点:「已添加(N)」计数真实增加(不增=早点击丢失,重试一次)
8. 确定 → 弹层关闭锚点
```

自动搜索未触发时兜底:点「从数据库中搜索」按钮再等一轮(queryForMultiEnum)。

## 输入通道:为什么必须 execCommand 且同一 eval 内

order-detail 双通道对照实证(2026-08-27):

| 通道 | 表现 |
|---|---|
| CDP `page.insertText` | DOM `input.value` 变了(锚点读到了),但 **React onChange 不一定触发**——点 db-search 按钮后组件拿**空 state** 查询,列表空 15s 超时。时灵时不灵(同页同字段两种结局) |
| eval 内 `execCommand('insertText')` | 完整 input 事件序列触发 onChange → 组件自动数据库全量搜索,数秒渲染完整结果(「成都万科」58 项) |

关键细节:**focus + select + execCommand 必须在同一次 eval 内完成**。跨 eval 分步时
聚焦丢失,execCommand 返回 false(quote-detail 时代「iframe 内不可靠」的结论真正原因)。

## 陷阱清单

1. **高亮拆分 span**:搜索结果项内关键词被拆成独立 span(`成都万科` + `物业服务有限公司`)
   ——manual-all 兜底逐 leaf 点击会**一项多点(选+取消)**,必须向上聚到行级容器、Set 去重
2. **清空 no-op**:「调 fill 函数传空列表」≠ 清空——fillEnumMultiSelect 空列表直接 return,
   清空从未执行。清空必须独立实现(开弹层→清空按钮→确定)且锚点验证字段确实为空
3. **断言语义随筛选语义变**:关键词模式下断言 = **正向条件值至少一项含关键词**;
   条件解析必须拆 posValues / negValues(notIn 出厂排除默认不算命中),否则关键词
   「关联」会被排除条件「关联方」假阳性命中
4. **搜索竞态**:输入后列表可能停留在旧内容,锚点用 every(item 含 kw) 判完成;
   「暂无搜索内容」必须同时校验 inputVal(输入没生效 ≠ 无结果)

## 断言语义

```javascript
// parse 阶段:按 functionalOperator 拆正向/排除
if (/^not/i.test(String(c.functionalOperator))) negValues.push(...vals);
else posValues.push(...vals);

// 断言阶段:关键词只需命中正向值
for (const kw of expected.keywords) {
  const hit = posValues.some((x) => String(x).includes(kw));
  if (!hit) throw new CommandExecutionError('关键词「' + kw + '」无匹配条件值…');
}
```

两层断言依然强制:UI 面(字段显示文本含匹配项)+ 真实值面(查询 payload 正向条件)。

## 测试清单

- [ ] 单关键词:结果数据全部满足过滤意图(客户名含关键词)
- [ ] 无匹配关键词:报「暂无搜索内容」且明确提示(有效答案,不是 bug)
- [ ] 残留清场:先设 A 字段再跑 B 字段,A 的值不出现在新查询条件里
- [ ] 跨月日期 + 关键词组合
- [ ] persistent 重复运行幂等(残留→清空→重设全链)
