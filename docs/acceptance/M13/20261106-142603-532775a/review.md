# M13 独立评审记录

- **评审对象**: commit 532775a9526674ccb2f82d1a73056477eef88115（M13 收口修复）+ 验收 run 20261106-142603-532775a
- **评审日期**: 2026-11-06
- **评审人**: 独立评审（与实现会话分离，基于 diff 与证据链复核）
- **结论**: **通过**，M13 转 accepted

## 评审维度与结论

### 1. P0 修复真实性
| 项 | 复核方式 | 结论 |
|---|---|---|
| fieldRef 落协议 | diff 审查：`updateProps` 命令分支写 `node.fieldRef`，清空删键；属性面板读 `node.fieldRef`；单测断言 `props.fieldRef` 为 undefined | 通过——B3-2 落库断言 protocol=true/props=false 实证 |
| 表达式阻断全路径 | `doSave` 内部拦截（manual/自动定时器/预览前统一入口），按钮 disabled 改为内部阻断 | 通过 |
| 自动保存并发 | `savedDoc` 引用快照 + `saving` 守卫 + 回执仅对未变 doc 清 dirty；定时器闭包依赖数组含 saving/exprErrors | 通过 |

### 2. 双端 ===/!== 契约
- **上一轮修复缺陷确认**：前端只补了优先级表（编译过），求值器 switch 无 `===` 分支 → 运行时「未知运算符」；且共享向量无该形态 → 回归全绿但无效。本轮补齐求值分支 + Java tokenizer/优先级/strictEquals + 向量 11 条（含跨类型不转换 3 条），双端 99/99 与 18/18 同判。**评审中补审发现跨类型语义未锁定，已补向量并双端复跑通过**。
- Java `strictEquals` 语义核对：Number 子类互比按 doubleValue（与 JS number 一致）；Boolean 跨类型 false；String/Number 跨类型 false——与 JS `===` 同判。通过。

### 3. 后端修复（验收发现的真实缺陷）
- `PageCommandService.snapshotModelRef`：发布快照 modelId 回退 schema.modelId。口径核对：04BE §1.3 快照结构 modelRefs 用于影响面与运行时消费——设计器绑定模型的页面理应进入。发布与回滚两条链路同口径（共用辅助方法）。通过。
- `PreviewDataGuard.collectPublishedModelId`：放行集补 published 页面 schema 的 modelId。安全边界核对：仍限定「限页会话的页绑定模型 ∪ 页面发布快照引用」，跨页模型依旧拒绝；未扩大到应用全量。租户条件保持。通过。
- 回归风险：既有发布/预览 IT 未覆盖 schema.modelId 场景（新增行为），但旧口径（pages.model_id 列）优先级不变，无行为回退。登记为后续 IT 补强项。

### 4. 编辑内核
- 失败命令回滚栈顶（`indexOf` 定位而非 blind pop——并发 execute 不误删他人快照）；dirty 由 `savedBaseline` 深比较（JSON 序列化键序一致性依赖同源 clone——store 内部一致）。单测 4 条新增全过。通过。
- 边界：`recomputeDirty` 在未 markSaved 前（无基线）用 `history.length > 0 || _dirty` 保底——装载态 undo 到初始时 dirty 正确为 false。通过。

### 5. 验收脚本与证据链
- A28 + B26 共 54 项，覆盖：拖拽/撤销/属性/表达式阻断/409 保护/发布预览隔离/绑定模型全链路（两段式建模→绑定→嵌套落库→大纲操作→409 差异→发布→预览可用表单→删字段标黄）。
- 断言真实性抽查：B3-2 双向断言（协议有/props 无）；B6 文案锚定「三方差异摘要」「节点数」；B7-3 负向断言（不出现未绑模型提示）；B8-2 dashed outline 视觉计数。无宽松匹配掩盖失败的假断言。
- 证据链：run-id 隔离 + manifest（sourceCommit=532775a 干净树）+ archive check PASS + 敏感检测（ACCEPT 凭证走环境变量未入库）。
- 旧证据（无 run-id）移入 `legacy/` 不作依据——符合规范第 6 节。

### 6. 遗留登记（不阻塞 accepted）
1. 409 差异表为摘要级（无字段级三方 diff）——01BE 口径符合，粒度优化随后续迭代
2. 大纲上移/下移仅验收入口可见性，排序效果由 store 单测覆盖（moveWithin 27/27 内含）
3. 真实鼠标手势级 HTML5 DnD 未直接验收（fiber 直调等价链路）——工具限制，登记说明
4. preview guard 的 schema.modelId 场景建议后续补 IT（当前由浏览器验收覆盖）
5. B7-2 发布后 3.5s 截图存在理论 flake 窗口（本轮稳定）

## 评审结论

M13 全部 P0/P1 缺口修复实证、验收 54/54、双端契约同步、证据链合规。**通过，转 accepted。**
