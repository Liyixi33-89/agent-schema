---
spec_id: 002-metadata-service
status: active
milestone: M2                # 依赖图 §3.3 元数据服务（关键路径）
created: 2026-10-28
last_verified_at: 2026-10-29
owner: 待定
---

# Spec · 元数据服务（M2 · 关键路径）

## 1. 背景与目标

依赖图 §3.3：元数据服务是数据引擎与全部设计器的上游。落地后端文档 01 的字段状态机（两段式保存/precheck 三档 confirmMode）、版本快照回滚、影响面分析、元数据缓存。前置：spec-001 协议冻结（MS1 门）+ spec-000 工程地基。

## 2. 范围声明

**做**：

- `meta_model/meta_field/meta_relation/meta_schema_version` 四表 DDL（Flyway V2，01BE §2）+ `meta_field_reference`（§4.5）+ `meta_confirm_token`（§4.2 token 消费记录）
- 字段状态机 + 两段式保存：precheck → confirmMode(INFO/CHECKBOX/TYPE_MODEL_NAME) → confirmToken 提交（01BE §3-4）
- **保存校验器全量接线（2026-10-29 补，01BE §4.2 步骤 4）**：枚举值结构/重复、关系目标存在（租户内谓词，跨租户同判不存在）、computed 结构/dependsOn/persistMode——规则与前端 validate.ts 同构（双端同判）
- **删除模型两段式（2026-10-29 补，01BE §4.1/§4.3）**：DELETE /{id} 不带 token = precheck 签发（固定 TYPE_MODEL_NAME）；带 confirmToken + confirmValue = 确认提交；token 绑定模型名摘要防挪用
- **COMPUTED 引用登记接线（2026-10-29 补，01BE §4.5）**：保存链路成功后由本服务登记 dependsOn 引用（此前仓储方法存在但从未被调用）
- **快照含 fieldStatus（2026-10-29 补）**：回滚 diff 按快照记录还原删除语义——回滚到「字段已删除」的版本时正确补删除，不再错误复活
- 版本快照与回滚（复用同一保存流程，01BE §4.4；回滚独立 precheck 绑定 targetVersion）
- 影响面分析：`field_reference` 表主路径 + DATA_VOLUME 降级占位（01BE §4.5；开放 API 聚合与真实数据量扫描随 M5 建表接入）
- 模型 CRUD（01BE §A.1）+ `/internal/references` 引用登记（M4.3 消费）
- TenantContext（03BE §2.1 接口化定版）+ TenantContextFilter（X-Tenant-Id 还原）
- 统一错误体（10BE §A.2）+ 01BE §A.5 错误码（FIELD_CONFIG_INVALID / RELATION_TARGET_NOT_FOUND → 422）

**不做**（随后续里程碑）：

- Redis 缓存 + pub/sub 失效 + 两阶段 ACK（M2.5 原范围——本地无 Redis；以版本号单调比对兜底，Redis 层随 M5 数据引擎读取链路一并落地，届时补两阶段 ACK）
- Outbox 事件发布（建表/失效事件消费方 data-engine 未落地，M5 联调时补）
- data-engine 侧 DDL 执行器（M5）
- 页面服务引用登记写入方（M4.3）
- 提升列任务执行（M5.4；本 spec 已产出 promote_status='PENDING' 状态与 promotedTasks 响应）

## 3. 接口契约

按 01BE §A 权威定义落地（`/api/models` CRUD、`/precheck`、`/schema`、`/versions`、`/rollback`、`/internal/references`）；错误体 `{code, message, traceId, details?}`；409 携带 `serverVersion`。

## 4. Tasks

- [x] T1 四表 + 引用表 + token 表 Flyway 脚本 V2（tenant_id 三件套齐备）
- [x] T2 ModelAggregate 领域模型（字段状态机收口；field_key/field_type 无改写入口）
- [x] T3 两段式保存 + precheck 三档 confirmMode + token 四元组校验（一次性消费/binding hash/baseVersion/confirmValue）
- [x] T4 版本快照/回滚（回滚独立 precheck 绑定 targetVersion；复活走草稿态不自动 promote）
- [x] T5 field_reference 登记 + 影响面聚合（DATA_VOLUME 随 M5 接真实扫描）
- [x] T6 租户上下文（接口化 TenantContextHolder + Filter 还原 + 跨租户拦截测试）
- [x] T7 01BE §测试要求全绿（真实 PG 集成测试 15 用例 + 领域测试 8 用例；2026-10-29 补校验器/删模型两段式/回滚删除语义/并发乐观锁后达 15）
- [ ] T8 Redis 缓存失效两阶段 ACK（随 M5 数据引擎读取链路落地时补）

## 5. Acceptance

- [x] A1 `verify -Level commit` 通过
- [x] A2 DELETED 字段不出现在活跃集合；meta_field 物理行保留（DDL 铁律断言）
- [x] A3 precheck 三档按引用数正确分档；confirmToken 一次性消费 + 绑定篡改拒绝
- [x] A4 回滚后字段复活 ACTIVE 且新版本标记 rollback_from
- [x] A5 伪造租户上下文被拦截（MODEL_NOT_FOUND 不给数据线索）
- [ ] A6 缓存失效端到端（Redis 未引入，随 M5 补；版本号单调比对先行）

## 6. 验证步骤

```text
1. docker compose up -d postgres（compose.yaml 本地 PG）
2. pwsh scripts/verify.ps1 -Level commit
3. 集成测试直跑：mvn test "-Dtest=MetadataCommandServiceIT"（真实 PG，Flyway V2 自动迁移）
```

## 7. 沉淀记录

- **回滚复活判定坑**：`rollback()` 内 `resurrectFieldDraft` 先改写内存聚合，`persistRollback` 若再以内存 `fieldStatus` 判复活路径会全部失配——复活判定必须查 DB 当前状态（`existsActiveInDb`）。教训：领域方法改写内存态后，持久化分支判定不能依赖同一内存对象。
- **token 消费档位来源**：confirmValue 是否必填由 token 签发时的 confirmMode 决定（precheck 定档），消费端不能写死保守默认——签发与消费必须同源，否则低风险保存被误拒。
- **测试口径**：token 二次消费验证需用「当前版本」重放（否则先撞乐观锁 409，测不到 token 层幂等）；两层防御的测试要瞄准目标层。
- **快照版本同步**：`advanceVersion` 只更新 DB，聚合内存版本需显式 `setCurrentVersion` 同步——否则快照写重复版本号撞唯一约束。
- **模块循环依赖**：集成测试需要 Spring 上下文与启动类 → 放 bootstrap 模块（组合根）；metadata-module 反向依赖 bootstrap 即循环，禁止。
- **幂等返回与 token 校验顺序（2026-10-29）**：`deleteModelConfirm` 若先判「已删除则幂等 return」再校验 token，已删除模型上重放已消费 token 会静默成功——token 一次性语义被幂等短路击穿。教训：确认类操作 token 校验必须前置于幂等返回；幂等仅保护「token 有效前提下的并发重复提交」。
- **「实现存在但从未被调用」审计（2026-10-29）**：`upsertComputedReferences` 仓储方法自 M2 首版即存在但保存链路从未调用——引用表永远为空、COMPUTED_REF 风险永不触发。教训：验收不能只看「方法存在 + 单测绿」，须验证消费方真实接线（本例由影响面测试补 COMPUTED_REF 断言暴露）。
- **集成测试门禁（2026-10-29）**：`*IT` 后缀不被 surefire 默认拾取 → `verify` 此前从不执行集成测试（7 用例形同虚设）。已在 verify.ps1 commit 级加 `backend-it` 步骤（TCP 探活 5432，PG 未就绪即 FAIL 不降级——集成测试门禁不可跳过）。CI 侧 Testcontainers 随 M5 接入。
