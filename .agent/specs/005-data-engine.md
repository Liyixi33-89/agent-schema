---
spec_id: 005-data-engine
status: active
milestone: M5                # 依赖图 §3.6 数据引擎（前置：M1.4/M2.1/M3.3）
created: 2026-10-29
---

# spec-005 · 数据引擎（data-engine-service）

> 真源：详细技术文档 02《数据引擎》§2-§4/§A.1-A.6；权限注入消费 03BE §3.3/§3.4
> 交付范围：M5.1 存储布局+动态 SQL / M5.2 权限注入 / M5.3 读时兼容 / M5.4 提升列任务 / M5.5 统一 CRUD 协议
> 批量导入导出（02BE §7）为 P2 分期，不在本 spec。

## 1. 任务清单

| # | 任务 | 出处 | 状态 |
|---|------|------|------|
| T1 | V6 DDL：data_physical_table 登记水位 + data_promote_task 幂等任务表 + 种子管理员范围 | 02BE §2/§4 | done |
| T2 | PhysicalTableManager：biz_model_<id> 动态建表（JSONB/GIN/标识符白名单双保险） | 02BE §2.1 | done |
| T3 | 建模联动：ModelCreatedEvent（Spring 事件）→ 同事务建表 | 02BE §2.1 | done |
| T4 | SqlBuilder：条件树递归（操作符白名单 11 种/字段仅元数据集内/值全占位符） | 02BE §3.2/§3.3 | done |
| T5 | 提升列直查 vs JSONB 表达式分流（promoted() 判定） | 02BE §3.3 第 3 步 | done |
| T6 | ScopeResolver 行级范围并集编译（ALL/SELF/DEPT/DEPT_TREE/CUSTOM_EXPR 受限） | 03BE §3.3 | done |
| T7 | 字段级权限：不可见物理剔除（含伪造投影交集）/不可编辑静默忽略 | 03BE §3.4 | done |
| T8 | ReadCompatibility：DELETED 强过滤 + _invalid 标记 + default 填充 + 版本短路 | 02BE §3.5 | done |
| T9 | 统一 CRUD 接口：A.1 query/getById/create/update/delete + A.3 unique-check | 02BE §A.1/A.3 | done |
| T10 | 聚合接口：A.4 measures 1-5/分组 topN≤50/时间桶 DAY-WEEK-MONTH/权限一致 | 02BE §3.6/A.4 | done |
| T11 | 错误码映射：FIELD_DELETED/PAGE_TOO_DEEP/RECORD_NOT_FOUND/VALIDATION_FAILED | 02BE §A.6 | done |
| T12 | PromoteTaskConsumer 轮询消费 PENDING（幂等 CAS；FAILED 回退 JSONB） | 02BE §4 | done |
| T13 | 预览态放行 /api/data（运行时页面数据源） | 04BE §A.7 | done |

## 2. 验收记录（02BE §8 硬性要求 → DataEngineIT 11 用例）

- [x] **SQL 注入三维度拦截**：字段名（FIELD_DELETED 同判不给线索）/操作符（FILTER_OPERATOR_INVALID）/值（占位符文本精确匹配不执行）—— injectionBlockedOnFieldOperatorValue
- [x] **DELETED 字段任何参数组合不可读**：filter 400 + 伪造投影交集剔除 + 详情响应剔除 —— deletedFieldUnreachableByAnyParamCombo
- [x] **读时兼容**：旧版本行类型不匹配值标 _invalid 保留原值不抛错 —— legacyRowMarkedInvalidNotThrown
- [x] **租户隔离**：跨租户模型同判不存在 + tenant_id 固定条件过滤 —— crossTenantInvisible
- [x] **行级权限 SELF 口径**：范围外 0 行/自己创建恰可见/无范围授权默认拒绝 —— selfScopeFiltersRows
- [x] **聚合权限一致**：无范围用户聚合值=0（权限外记录不参与 COUNT）—— aggregateRespectsRowScope
- [x] **聚合分组 topN 排序**（度量 DESC）—— aggregateGroupAndTopN
- [x] **聚合护栏**：非法聚合函数 400（白名单 SUM/AVG/COUNT/COUNT_DISTINCT/MAX/MIN）—— aggregateGuardrails
- [x] **深分页**：page×size>100000 → 400 PAGE_TOO_DEEP —— deepPageRejected
- [x] **CRUD 全链**：create→getById→update→逻辑删除后 404 —— createAndUpdateFlow
- [x] **未定义字段静默剔除**（前端全量提交容错）—— requiredFieldRejected

## 3. 设计决策与妥协

- **模块解耦**：MetadataPort/DataPermissionPort 端口在 data.domain，进程内适配器直连 metadata/iam 应用服务（bootstrap 组合根背书）；拆分后换 RPC 实现端口不变。
- **建模建表走 Spring 事件**：metadata 不反向依赖 data-module；@EventListener 默认同步同事务（建表失败连带建模失败保证一致）。
- **无 MQ 的提升列消费**：轮询 5s 替代 ddl.promote 订阅（Kafka 随事件基建分期）；幂等靠 data_promote_task 唯一键 + INSERT ON CONFLICT WHERE status<>'ACTIVE'（双实例重复消费防护）。
- **CUSTOM_EXPR MVP 受限形态**：仅 `fieldKey op ${currentUserId|currentUserDeptId}` 二元比较；危险词黑名单（select/join/;/--/*/union）+ 结构正则白名单双闸，不匹配一律 1=0（宁拒勿放）。
- **种子管理员通配范围**：V6 给 userId=1 建 seed_data_admin 角色 + model_id=0 的 ALL 范围（适配器通配匹配）；生产态按模型建号授权。
- **无范围授权 = 默认拒绝（1=0）**：02BE 权限铁律的字面落地——测试证明无角色用户查询/聚合全为 0。
- **提升列失败回退免费**：promoted() 判定 promote_status='ACTIVE' 才走列直查，FAILED 自动回 JSONB 表达式（无需显式降级路径）。
- **字段权限语义**：MVP 按「FIELD 行授权集为空 = 全可见」处理（未配置字段权限的模型不锁死）；显式配置后走授权集判定。

## 4. 延后项登记

- **DataLoader 批量关联拼装**（§2.3 防 N+1）：relationDepth 参数已入协议，拼装逻辑随 M6 渲染引擎的真实 relation 消费落地。
- **relation 目标记录存在性校验**（§3.4 第 3 步）：随 relation 字段实际启用（M6 表单提交链）。
- **批量导入导出**（§7）：P2 分期。
- **statement_timeout 3s 熔断 + X-Suggest-Index 引导**：性能护栏随压测阶段（M16）接入。
- **游标分页（keyset）**：深分页拒绝已落地，cursor 协议随前端列表虚拟滚动需求排期。
- **Redis 元数据三级缓存**：单租户单体态进程内直查即可，随拆分/多租户性能需求启用。
- **record.created/updated/deleted 领域事件**（§3.4 第 6 步）：MQ 未接入前不发；消费方（流程触发器/Webhook/计量）均未落地。
- **computed PERSISTED 字段写入重算**：表达式引擎复用 M1 后端 ExprEngine，随 M6 计算字段真实启用接线。
