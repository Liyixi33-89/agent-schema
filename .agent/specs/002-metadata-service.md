---
spec_id: 002-metadata-service
status: draft
milestone: M2                # 依赖图 §3.3 元数据服务（关键路径）
created: 2026-10-28
last_verified_at: null
owner: 待定
---

# Spec · 元数据服务（M2 · 关键路径）

## 1. 背景与目标

依赖图 §3.3：元数据服务是数据引擎与全部设计器的上游。落地后端文档 01 的字段状态机（两段式保存/precheck 三档 confirmMode）、版本快照回滚、影响面分析、元数据缓存。前置：spec-001 协议冻结（MS1 门）+ spec-000 工程地基。

## 2. 范围声明

**做**：

- `meta_model/meta_field/meta_relation/meta_schema_version` 四表 DDL（Flyway，01BE §2）
- 字段状态机 + 两段式保存：precheck → confirmMode(INFO/CHECKBOX/TYPE_MODEL_NAME) → confirmToken 提交（01BE §3-4）
- 版本快照与回滚（复用同一保存流程，01BE §4.4）
- 影响面分析：`field_reference` 表 + 开放 API 聚合 + 数据量扫描（01BE §4.5）
- 元数据缓存：Redis + pub/sub 失效 + 删除两阶段 ACK（01BE §5）
- 自动建物理表联动：模型创建发领域事件，data-engine 消费建表（与 M5.1 联调项，本 spec 只交付事件）

**不做**：

- data-engine 侧 DDL 执行器实现（M5，本 spec 仅发事件）
- 页面服务的字段引用登记写入方（M4.3 消费本 spec 的 `/internal/references` 接口）
- 提升列任务（M5.4）

## 3. 接口契约

```text
管理 API（01BE §A）：
POST   /api/admin/models                        建模型（同步建表事件）
PATCH  /api/admin/models/{id}/fields            字段变更（两段式：dryRun=true 返回 precheck 结果）
POST   /api/admin/models/{id}/fields/confirm    confirmToken 提交
POST   /api/admin/models/{id}/fields/{key}/delete   删除（逻辑删，走 precheck 三档）
GET    /api/admin/models/{id}/versions          版本列表
POST   /api/admin/models/{id}/rollback/{version}    回滚
内部 API：
GET    /internal/references?fieldKey=...        影响面聚合（页面/流程/脚本引用计数）
领域事件：
metadata.model.created / metadata.field.deleted （Outbox 发布，消费方：data-engine 缓存失效与建表）
```

## 4. Tasks

- [ ] T1 四表 Flyway 脚本（遵循 flyway-migration-discipline：tenant_id 三件套见 tenant-isolation-guard）
- [ ] T2 ModelAggregate 领域模型（字段状态机收口，聚合根纪律 skill）
- [ ] T3 两段式保存 + precheck 三档 confirmMode
- [ ] T4 版本快照/回滚
- [ ] T5 field_reference 登记 + 影响面聚合接口
- [ ] T6 Redis 缓存 + pub/sub 失效 + 两阶段 ACK
- [ ] T7 Outbox 事件发布（建表/失效两类）
- [ ] T8 01BE §测试要求全绿（含伪造租户拦截单测）

## 5. Acceptance

- [ ] A1 `verify -Level commit` 通过
- [ ] A2 DELETED 字段不出现在默认 API 响应；物理列未删（DDL 铁律）
- [ ] A3 precheck 三档按数据量与引用数正确分档；confirmToken 一次性消费
- [ ] A4 回滚后 schema_version 快照与数据兼容层联动（版本比对优化路径生效）
- [ ] A5 缓存失效端到端：改字段 → pub/sub → 读方失效重载（两阶段 ACK 完成前旧缓存可用）
- [ ] A6 伪造租户上下文被拦截（租户单测硬性项）

## 6. 验证步骤

```text
1. pwsh scripts/verify.ps1 -Level commit
2. curl 两段式保存全流程：dryRun → confirm → 查默认响应无 DELETED 字段
3. redis-cli 监听失效频道，改字段观察失效消息
```

## 7. 沉淀记录

（结项回填）
