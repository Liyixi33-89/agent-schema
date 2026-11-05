# 独立审查：M8-M10 计量文件通知依赖图完整验收

- 审查对象：M8-M10（计量/文件/通知依赖组完整验收）
- 审查基线提交：`043d832`（含 efcda1a 实现提交）
- 证据报告：`docs/acceptance/M8M10/legacy/M8M10-it-report.md`
- 审查结论：**批准（approved）**

## 审查范围

对照依赖图 M8/M9/M10 完整验收项，独立复核证据是否成立、有无遗漏或伪证。

### M8 计量埋点采集
- M8.2 后端埋点采集端（登录/建模/发布/席位事件 → metering.raw）：
  - 建模✓ / 发布✓ / 席位✓（既有 DesignerWriteEvent 接线）
  - **登录补齐**：`LoginSucceededEvent` + `AuthService.login` 发布 + `LoginMeteringListener` 落 `seat.active(SERVER, surface=login)`。事件发布方零依赖 metering（Spring 解耦），符合 09BE §4 服务端终审防伪造口径。**属实，非伪证。**
- M8.3 事件入库 + 日聚合（幂等去重 / 时区补算）：既有 `MeteringSchedule` 迟到兜底 + 幂等（eventId）+ 时间归属限回溯。**既有覆盖成立。**
- M8.4 授权席位判定与并发：既有 `LicensedSeatCalculator` + FOR UPDATE + 快照。**既有覆盖成立。**

### M9 文件服务
- M9.1 ObjectStorage 接口 + MinIO/LocalFs 双实现 + **契约测试**：
  - 接口✓、LocalFs✓、MinIO 双实现（本地无 MinIO，11BE §2 已声明随部署接入，属分期）。
  - **契约测试补齐**：`ObjectStorageContractIT` 仅通过 `ObjectStorage` 接口验证 write/read/head/delete/presign/分块生命周期/路径穿越，S3StorageImpl 未来可复用同套契约。**属实。**
- M9.2 预签名直传 + complete 校验 + scope 白名单：既有覆盖。**成立。**

### M10 通知服务
- M10.1 notify_message 模型 + 站内信通道 + 未读数：既有覆盖。**成立。**
- M10.2 模板引擎 + 频控：既有覆盖（渲染占位降级/频控 SUPPRESS/SECURITY_ALERT 豁免）。**成立。**
- 业务事件接线：`NotificationService.send` 即接线点，MVP 只交付站内信通道，审批待办由流程引擎（Phase 2）调用——**登记的分期决策**，非缺口。**成立。**

## 证据核验

- 证据报告在仓库内（`docs/acceptance/M8M10/legacy/M8M10-it-report.md`）✓
- 报告记载测试结果：ObjectStorageContractIT 7 tests / MeteringIT 15 tests 全绿；完整集成门禁 143 tests 0 error 0 failure ✓
- 报告 command 可复现（WSL 内 PG 执行集成测试）✓
- 无伪造证据；所有「既有覆盖」均已由先前 FIX 任务证据（FIX-M8M9M10-it-report）背书

## 结论

M8-M10 依赖组完整验收项全部落实：登录埋点接线、ObjectStorage 契约测试为本次补齐；其余项由既有实现覆盖或已登记分期决策。**批准 implemented → accepted。**

## 遗留说明（非阻塞）

- verify.ps1 backend-it 在本机 Windows 侧探活 127.0.0.1:5432 探不到 WSL PG（Windows→WSL 网络半失效环境妥协）；集成测试本体已在 WSL 内全绿，CI（Linux/pwsh）无此问题。