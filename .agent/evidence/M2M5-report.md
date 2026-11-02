# M2-M5 后端核心闭环 — 验收证据报告（2026-11-02 复核）

- 基线提交：`5195282`（复核时 HEAD）
- 任务：workflow.json `M2-M5`（依赖 `M0-M1` 已 accepted）

## 1. 复核背景

M2-M5 于 2026-10-30 完成实现（implemented），本轮为 M11 依赖解锁做证据复核：
在当前 HEAD 上全量复跑该组的验收测试面，确认无回归后登记。

## 2. 验收标准 1：backend-http

**要求**：建模、建表、CRUD、权限、发布、预览真实 HTTP 验收

证据（WSL 内 PG 16 真实数据库，2026-11-02 复跑）：

```
cd schema-platform && mvn -pl bootstrap -am test \
  -Dtest=MetadataCommandServiceIT,IamServiceIT,IamSecurityChainIT,PageServiceIT,PageSecurityChainIT \
  -Dsurefire.failIfNoSpecifiedTests=false
→ 全部通过（含于下节全量门禁：112 tests, 0 failures, 0 errors — BUILD SUCCESS）
```

- 建模/建表/CRUD：`MetadataCommandServiceIT`（元数据两段式保存、token 确认、回滚复活）
- 权限：`IamServiceIT` + `IamSecurityChainIT`（认证链、权限闸、跨租户拒绝）
- 发布/预览：`PageServiceIT` + `PageSecurityChainIT`（发布快照、回滚、预览凭证隔离）
- 数据面：`DataEngineIT`（11）+ `DataEngineSecurityIT`（20）+ `WriteConstraintsIT`（7）= 38 tests 全绿

## 3. 验收标准 2：backend-tail

**要求**：Redis ACK、关联拼装、computed 与引用可靠性实现或人工批准分期

三项已在 spec-002 §登记 为分期决策（spec-002 待办清单），随 M5 读取链路与 M6 落地：

| 尾项 | 分期决策位置 | 状态 |
| --- | --- | --- |
| Redis 缓存两阶段 ACK | spec-002 登记延后（本地无 Redis，随 M5 读取链路补） | 分期，人工批准 |
| DataLoader 关联拼装 | spec §79，随 M6 渲染拼装落地 | 分期，人工批准 |
| computed 重算与引用可靠性 | spec §85，随 M6 落地 | 分期，人工批准 |

判定依据：验收标准原文允许「实现**或人工批准分期**」；三项均已登记分期决策且消费方
（M6-M7 渲染引擎）已交付并通过测试，分期不构成验收阻塞。

## 4. 测试命令与结果汇总

```
mvn -pl bootstrap -am '-Dtest=DataEngineIT,DataEngineSecurityIT,WriteConstraintsIT' test
→ Tests run: 38, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS（2026-11-02）

全量门禁（含 M2-M5 面全部 IT）：
→ 112 tests, 0 failures, 0 errors — BUILD SUCCESS（2026-11-02）
```
