# M14 独立审查（independent-review-session · 四维）

- 审查对象：run 20261111-160118-33d75cf（33d75cf2e31774016b6e2b95dede44c391b95f4e，干净树）
- 审查会话：independent-review-session（≠ implementation-session-f42b4e21）
- 单人模式：singleReviewerMode enabled（2026-11-09 会话决策）——GitHub 实时审批豁免，四维审查与必需 CI verify 仍强制；本审查为独立会话口径，不伪造 GitHub APPROVED

## 维度一：需求（requirements）

- 真源核对：PRD §5.1 门禁 G7「L2 隔离：Worker 隔离验收（08FE §8）通过前 L2 不开放」+ 前端方案 §2 脚本隔离（08FE §8 十项）。矩阵 6 条需求（M14-REDLINE/BUILD/ISO/BRIDGE/TERM/PERSIST）全部可回溯至真源条款。
- 用户 2026-11-11 口头补充的七域验收范围（红线/编译/隔离/消息桥/硬中断/绑定/发布隔离）与矩阵一一对应：发布隔离并入 M14-PERSIST 的 negativeTests（发布快照独立断言 PUB-* 已实测）。
- 延期项 Monaco：登记为 deferred，approvedBy=human-lead（2026-11-10 实现评审：P1 以 scanSource 列表呈现替代，P2 评估）——有批准出处，符合「没有批准就不能直接排除」。

## 维度二：代码（code）

- 抽查 worker-bootstrap.ts：neuter 用 `Object.defineProperty(self, n, {value: undefined, writable: false})` 遮蔽原型链（fetch/XHR/WebSocket/eval/Function/importScripts）——注释明确记录「delete self.x 只删自有属性」的坑位；浏览器套件 ISO 断言实测四能力面不可达。
- 抽查 script-host.ts：双通道超时（worker.terminate() 物理终止 + 主线程 Promise 拒绝）注释清晰；TERM 断言实测死循环 3s 内终止、主线程 alive、页面无白屏。
- 后端 ScriptApiController 注册名代理（固定只读映射）、BuildController 编译链路——实现路径在 6b180ed..33d75cf 无变化（门禁判定仅 scripts/docs/.agent 变更）。

## 维度三：测试（tests）

- 单测：script-host 45、schema-protocol 105、后端 PageServiceIT 8/8、RedlineVectorTest 6/6（verify[commit] 11 步全绿门禁覆盖）。
- 验收套件：g7-api 6/6（含无凭证 401、未注册 422 负例）+ g7-browser 16/16（含 RED-NEG 422 负例、畸形 params 容错、死循环终止负例）——负例覆盖满足 high-risk 需求的 negativeTests 要求。
- 断言真实性：本轮 g7-browser 16 断言全部经 record() 进 results 数组（修复了上轮证据形态缺陷——13 处 console.log 断言不进结果文件）；fail-fast 保留（非预期状态仍抛出，exitCode 真实）。

## 维度四：证据（evidence）

- 同源同版：受控构建 20261111-155946-33d75cf（干净树、backendIdentity 注入校验）；运行实例 identity sourceCommit=33d75cf verifiable=true instanceId=3f52eb04——被测即所建。
- 部署稳定：runtime-static before=after（07bbd538）；backend-identity 前后一致且实例 UUID 稳定。
- workingTreeClean=true（对比上轮 154305 的 false——本轮为终验轮，上轮保留作过程记录）。
- 归档：14 文件 manifest 哈希清单，evidence check PASS；报告边界如实登记（公网面未重部署、节流计数由单测覆盖、死循环保存期不拦截为架构口径）。

## 结论

四维审查通过。遗留登记（非阻断）：

1. 公网验收面（111.231.57.177/accept/）未部署 33d75cf——本地栈证据链完整，公网面部署随 M15 端到端轮统一更新；
2. Monaco 编辑器延期项按批准出处登记，P2 评估；
3. 单容器 Worker 无 HPA（P1 口径，依赖图登记项）。

- reviewer: independent-review-session
- approved: true
- approvalReference: docs/acceptance/M14/20261111-160118-33d75cf/review.md
