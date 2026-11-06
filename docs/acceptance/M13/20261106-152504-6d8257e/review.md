# M13 独立评审记录

- **评审对象**: commit 532775a → 6d8257e（M13 收口修复 + 评审中向量补充）+ 验收运行 20261106-142603-532775a / 20261106-152504-6d8257e
- **评审日期**: 2026-11-06
- **评审人**: 独立评审（与实现过程分离，基于 diff 与证据链复核）
- **结论**: **通过**，M13 转 accepted

## 评审维度与结论

### 1. P0 修复真实性
- **fieldRef 落协议**：updateProps 命令分支写 node.fieldRef（清空删键），属性面板读 node.fieldRef；单测断言 props.fieldRef 为 undefined。B3-2 落库双向断言（protocol=true/props=false）实证。通过。
- **表达式阻断全路径**：doSave 内部拦截统一手动/自动/预览三入口；按钮 disabled 改内部阻断。通过。
- **自动保存并发**：savedDoc 引用快照 + saving 守卫 + 回执仅对未变 doc 清 dirty；定时器闭包依赖含 saving/exprErrors。通过。

### 2. 双端 ===/!== 契约
- 上一轮修复缺陷确认：前端只补优先级表（编译过）求值器无分支（运行时「未知运算符」），向量缺形态致回归全绿但无效——本轮补齐。评审中追加审查发现跨类型语义未锁定，补 3 条向量（number vs string / bool vs number 不隐式转换）双端复跑通过（前端 99/99、Java 18/18）。
- Java strictEquals 语义核对：Number 子类互比按 doubleValue、Boolean 跨类型 false、String/Number 跨类型 false——与 JS === 同判。通过。

### 3. 后端修复（验收发现真实缺陷）
- snapshotModelRef：发布/回滚共用辅助方法同口径；旧口径（pages.model_id 列）优先级不变，无行为回退。通过。
- collectPublishedModelId：安全边界核对——仍限「限页会话的页绑定模型 ∪ 页面发布快照引用」，未扩大应用全量，租户条件保持。通过。
- 回归风险：该场景无既有 IT（浏览器验收覆盖），登记后续补强。

### 4. 编辑内核
- 失败命令 indexOf 定位回滚栈顶（并发 execute 不误删他人快照）；dirty 由 savedBaseline 深比较（同源 clone 键序一致）；装载态 undo 回初始 dirty=false 正确。单测 27/27（新增 4 条）。通过。

### 5. 验收脚本与证据链
- 54 项断言真实性抽查：B3-2 双向、B6 文案锚定、B7-3 负向断言、B8-2 dashed outline 视觉计数——无宽松匹配假断言。
- 证据链：run-id 隔离 + manifest（sourceCommit=6d8257e 干净树）+ archive check PASS + 凭证走环境变量未入库。
- 旧证据移入 legacy/ 不作依据（规范 §6）。首个 run 20261106-142603-532775a 因评审补向量触发源码变更，按门禁在最终树重跑 20261106-152504-6d8257e——两 run 均保留，后者为准。

### 6. 遗留登记（不阻塞 accepted）
1. 409 差异表摘要级（无字段级三方 diff）——01BE 口径符合，粒度随后续迭代
2. 大纲上移/下移仅入口验收（排序语义 store 单测覆盖）
3. 手势级 HTML5 DnD 未直测（fiber 直调等价链路）——工具限制
4. preview guard schema.modelId 场景建议补 IT（当前浏览器验收覆盖）
5. B7-2 发布后 3.5s 截图存在理论 flake 窗口（两轮均稳定）

## 评审结论

M13 全部 P0/P1 缺口修复实证、验收 54/54（最终树复跑）、双端契约同步、证据链合规。**通过，转 accepted。**
