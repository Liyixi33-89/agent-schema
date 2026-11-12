# M12 独立审查（independent-review-session · 四维）

- 审查对象：run 20261112-170616-7359cb8（7359cb872b367e1cc99dd626363ee8c884b52453，干净树）
- 审查会话：independent-review-session（≠ implementation-session-f42b4e21）
- 单人模式：singleReviewerMode enabled（2026-11-09 会话决策）——GitHub 实时审批豁免，
  四维审查与必需 CI verify 仍强制；本审查为独立会话口径，不伪造 GitHub APPROVED。
- 审查动因：旧证据为 legacy 形态（无 manifest/无 evidence 对象/review=null），且实现路径在
  4b8f374..HEAD 间变更触发门禁连锁失效——须在同一提交重建证据后方可恢复 accepted 认定。

## 维度一：需求（requirements）

- 真源核对：M12 台账验收项「画布建模、两段式保存、影响面确认、版本回滚浏览器闭环」四域 +
  旧报告七域（补删除确认、409 草稿保护、权限负例）。需求矩阵 7 条（M12-CANVAS/TWO-PHASE/
  IMPACT/ROLLBACK/DELETE/409/PERM）全部可回溯真源：02BE §4 两段式协议、01FE §5 影响面交互、
  spec-002 回滚复活口径、PRD 门禁 G3 浏览器闭环。
- 七域映射核验：er-modeler 49 断言覆盖建模→保存→回滚主链；nine-scenes 33 断言覆盖九类独立
  UI 场景（含配置编辑/删除确认/高风险确认/多应用隔离/异步）；closeout 18 断言覆盖 409 草稿
  保护全链（9 步）+ 双击幂等 + B1 冷启动。无遗漏域。

## 维度二：代码（code）

- 抽查 ModelAggregate 两段式保存：token CAS 一次性消费、changes-hash 绑定、confirmValue
  按签发档位校验（findTokenMode）——spec-002 沉淀的四坑位均有对应实现。
- 抽查回滚链路：快照含 fieldStatus（dbdc4c1 修复口径），diffSnapshotToChanges 显式分支，
  回滚不复活已删字段断言实测。
- React Flow 画布（4b8f374 迁移）：Handle 锚点、canvasEpoch 重挂载、两段式布局持久化——
  本轮九场景⑨关系边渲染/连线创建/删除落库实测通过，旧备注「SVG 自实现」已过时，
  台账 note 本轮同步更新。

## 维度三：测试（tests）

- 三套件 100/100：er-modeler 49（含 token 重放被拒、跨应用 404、普通成员 403 负例）、
  nine-scenes 33（含高风险错误名阻断、未勾选不可提交、放弃修改对齐负例）、
  closeout 18（含 409 三方差异、无偷偷重发、B1 冷启动非白屏）。
- 高风险需求 negativeTests 全覆盖：token 挪用、confirmValue 错误、409 外部冲突、
  越权 403/404、冷启动。
- 断言真实性：全部 record() 进 results 数组（evidence 交叉核对计数一致）；fail-fast 保留；
  DB 落库核对走 WSL psql 真实通道。

## 维度四：证据（evidence）

- 同源同版：受控构建 20261112-161930-7359cb8（干净树、backendIdentity 注入校验）；
  jar build-source.txt=7359cb8…；运行实例 identity verifiable=true。
- 稳定性：stability.json 四产物哈希套件后实测复检 unchanged=true（与 products.json 逐一相等）；
  部署采样三探针（两全量一静态）前后一致。
- workingTreeClean=true；归档 manifest 哈希清单，evidence check PASS。
- 过程 run 如实丢弃：四次中间 run（探针适配/products 形态修正）不作为证据，
  终验轮单独成 run——报告中如实登记。
- 部署探针配置命名与忽略规则已对齐先例（accept-deploy-*.config.json）。

## 结论

四维审查通过。M12 证据重建符合当前门禁全部要求，恢复 accepted 认定有效。
遗留登记（非阻断）：

1. 孤立模型单行横排——交互优化随 M13；
2. 409 无三方合并（01BE 口径）；
3. 本轮为本地栈证据；公网验收面部署与复验随 M15 工作包二统一执行。

- reviewer: independent-review-session
- approved: true
- approvalReference: docs/acceptance/M12/20261112-170616-7359cb8/review.md
