# M13 页面设计器与预览 — 独立审查报告（run 20261110-125327-ee046dd）

- 审查对象：M13 页面设计器与预览（gateVersion=2）
- 审查基线：ee046dda1c06387a73a11ee0fb1b7db10b2e2e85（证据归档 sourceCommit，与 HEAD 一致）
- 需求基线：`.agent/specs/013-page-designer.md`（真源：PRD 02、04FE、04BE §A.1/A.2/A.4/A.7）
- 审查者：independent-review-session（非实现会话 implementation-session-f42b4e21；按 .agent/workflow.md §「V2 需求覆盖与批准门禁」执行）
- 审查日期：2026-11-10
- 审查方法：逐项核对需求矩阵 ↔ 实现代码 ↔ 测试脚本真实断言 ↔ 归档证据（四维），不复述测试结果、不依赖实现者陈述；关键断言点抽查源码与落库通道。

## 1. Requirements（需求覆盖）— 8/8

| 需求 | 基线核对 | 覆盖证据 | 判定 |
|---|---|---|---|
| M13-SAVE 保存竞态 | spec §5 A10/04FE §3：30s 自动保存、重复触发不并发 | race C3-1~C3-7（fetch 拖慢 2.5s 制造窗口、期间编辑保持 dirty、内容落库、版本链一致）+ C3b-1~3（30s 定时器真实触发断言） | ✅ |
| M13-CONFLICT 409 三方差异 | spec §5 A7：409→冲突弹层→草稿保留→显式解决 | page-designer A7-1~4/B6-1~5（三方差异表渲染、节点数维度）+ race C4 全链（保留→仍冲突→换基线→替换成功→重开验证） | ✅ |
| M13-DRAG 原生拖拽 | spec §5 A4：物料拖入、容器嵌套、排序、删除 | A4-3~6/B4-0~3/B5-1 + race C2-1（**cdp-real-mouse isTrusted=true，dragstart=1, drop=1**——CDP Input.dispatchMouseEvent 真实鼠标序列，非合成事件链） | ✅ |
| M13-WIZARD 模型生成默认页 | spec §5 A3/§4 T8：字段类型→物料映射生成骨架 | race C1-1b~C1-4（Switch 默认开启回归 4c5b398、4×FormItem 骨架、fieldRef 递归断言） | ✅ |
| M13-PREVIEW 发布预览 | spec §5 A8：发布→grant/exchange→预览渲染与画布一致 | A8-1~7（grant 重放 401 负例、exchange 15min、预览隔离通道）+ B7-1~3（绑定页预览渲染表单字段） | ✅ |
| M13-EXPR 表达式阻断 | spec §5 A6：错误标红且阻断保存 | A6-1~6（语法错误→保存 disabled→提示可见→修正后保存成功→落库） | ✅ |
| M13-HISTORY 编辑内核 | spec §5 A1：undo/redo 深比较、栈 50 截断、dirty 状态机 | designer-store.test.ts 28/28（审查中实际重跑 PASS）+ A4-5/6 | ✅ |
| M13-SCOPE 范围外不冒充 | spec §2「不做」清单 | 54 场景断言全部落在 P1 范围；列表专项/L2 脚本/仪表盘无入口断言 | ✅ |

范围外延期项（编辑锁/复制降级/列表专项等）在 spec §2 逐条登记，矩阵未将其计入验收——无超范围冒充。

## 2. Code（实现抽查）

- **doSave 竞态门控**（PageDesignerTab.tsx:345-379）：`structuredClone` 深快照固定请求内容；`savingRef` 同步锁防并发；回执仅推进该快照基线（`store.markSaved(savedDoc)`），期间新编辑保持 dirty——实现与矩阵声明一致，无「回执吞编辑」路径。
- **409 冲突弹层**（:546-578）：`closable={false}` 阻止误关；三选项语义正确——稍后处理仅 `setConflict(null)` 不动版本（自动保存被 `conflictPendingRef` 暂停）；准备替换 `setDraftVersion(serverVersion)+markSaved(serverDoc)` 换基线保留本地内容；放弃重新拉取并校验迁移。`ConflictDiff`（:671-725）三方 flatten 按节点 id 对比 + 节点数/绑定数/表达式数统计维度。
- **30s 自动保存**（:336-343）：`dirty && !saving && exprErrors===0` 三条件门控；定时器依赖正确。
- **表达式阻断**（:314-332）：walk 全树收三键表达式错误，`doSave` 内统一拦截手动/自动/预览路径。
- **已知边界**（非阻塞）：`doSave` 依赖数组含 `draftVersion/conflict`，保存成功后 useCallback 重建——竞态窗口由 savingRef 同步锁覆盖，实测 C3-7 版本链一致；单标签页语义下无缺口。

## 3. Tests（测试有效性）

- 归档场景 54+32 全 pass；逐条核对关键场景断言为**结果断言**而非存在性断言：
  - C4-3c「服务器此刻不含本地内容」——断言保留后服务器草稿字符串不含本地编辑内容（保留≠落库，如实冲突态）；
  - C4b-5/6「替换后服务器被本地内容替换且不再含外部独有内容」——闭环核心；
  - C3-2「响应被门控挂起（in-flight 确认）」——真实挂起窗口而非 sleep 推测；
  - B4-3 嵌套结构落库断言查服务器草稿 children 结构。
- 负例覆盖高风险项：grant 重放 401（A8-7）、表达式错误阻断（A6-2/3）、409 保留后再存仍冲突（C4-1~6 链内）、落点拒绝四族（单测 13-17）。
- 单测计数口径修正：矩阵登记「page-designer 单测 27/27」，实际 designer-store.test.ts **28** 项（审查中重跑 28/28 PASS）——计数偏差不影响覆盖结论，已登记 findings。

## 4. Evidence（证据链）

- run 20261110-125327-ee046dd：双套件同 run 同部署同源码版本（sourceCommit=HEAD=ee046dd，workingTreeClean=true）。
- 产物来源：products.json designer-accept sha256=28cd68af…（sourceCommit=ee046dd 一致）；受控构建记录 out/builds/20261110-125030-ee046dd.json（JAR 内 build-source.txt 校验=ee046dd）。
- 部署采样：deployment.json before=after=localDist（静态三面一致）；后端 build-identity commitMatchesSource（ee046dd）、instanceId 前后一致（6df2f8ea）——**本轮起部署端与被测版本同 SHA**。
- 稳定性：stability.json 双构建哈希一致。
- CI：PR #4 verify 绿（ee046dd）。
- 归档校验：evidence.cjs check PASS（哈希全覆盖）。

## 5. Findings

| # | 级别 | 发现 | 状态 |
|---|---|---|---|
| F1 | 非阻塞 | 单测计数口径：矩阵登记 27/27，实际 designer-store.test.ts 28 项（重跑 28/28 PASS）——登记口径修正，覆盖无缺口 | resolved（本报告记录） |
| F2 | 非阻塞 | C2 拖拽双形态设计（CDP 真实鼠标主路径+合成链回退）：本轮归档实证主路径 isTrusted=true 生效，回退路径未触发——形态记录如实 | resolved |
| F3 | 非阻塞 | doSave useCallback 依赖含 draftVersion/conflict 致保存后函数重建——同步锁覆盖竞态，单标签页语义无缺口；多标签并发属编辑锁延后项（spec §2 登记，M16 前评审） | resolved（登记延后项） |
| F4 | 非阻塞 | 公网面未认证探针 401（浏览器路径不受影响）——稳定性脚本降级判定如实记录 | resolved |

## 6. 结论

需求矩阵 8/8 覆盖、实现抽查与声明一致、测试为结果断言含负例、证据链同源同版且部署端身份与被测版本一致。**四维审查通过，无阻塞发现**；建议 M13 转 accepted（GitHub 实时审批按 workflow.md §V2 由 PR 审批独立验证）。
