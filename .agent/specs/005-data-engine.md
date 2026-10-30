---
spec_id: 005-data-engine
status: active
milestone: M5                # 依赖图 §3.6 数据引擎（前置：M1.4/M2.1/M3.3）
created: 2026-10-29
updated: 2026-10-30          # 收口修复：审查发现的权限/预览/校验/聚合/提升列缺口全闭环
---

# spec-005 数据引擎

## 1. 任务表

| # | 任务 | 出处 | 状态 |
|---|------|------|------|
| T1 | 动态建表 biz_model_<id>（幂等 + 提升列同步生成） | 02BE §2 | done |
| T2 | 条件树 SQL（字段/操作符白名单 + 值占位符） | 02BE §3.3 | done |
| T3 | 统一 CRUD 协议（query/getById/create/update/delete） | 02BE §A.1 | done |
| T4 | 租户固定条件 + SELF 行级范围 | 02BE §3.3 | done |
| T5 | 读时兼容（_invalid 标记不抛错） | 02BE §3.5 | done |
| T6 | 基础聚合（分组/时间桶/topN） | 02BE §3.6 | done |
| T7 | 提升列异步任务轮询消费 | 02BE §4 | done |
| T8 | DEPT/DEPT_TREE/CUSTOM_EXPR 范围编译（真实部门上下文 + 默认拒绝 + 子查询租户条件） | 03BE §3.3 | done（2026-10-30 收口） |
| T9 | 字段级权限（授权集语义：未配置=全可见；已配置=仅授权集可见/可编辑） | 03BE §3.4 | done（2026-10-30 收口） |
| T10 | 预览数据面安全边界（写拒绝 + allowRealWrite + 限页模型范围 + 发起人透传） | 04BE §A.7 | done（2026-10-30 收口） |
| T11 | 写入校验链（类型/长度/正则/范围/枚举/relation 存在性/更新 required） | 02BE §3.4 | done（2026-10-30 收口） |
| T12 | 批量 upsert /batch（≤500 行，keyField 冲突更新） | 02BE §A.1 | done（2026-10-30 收口） |
| T13 | 唯一性收口（应用层预检注入行级范围条件 + UNIQUE 部分索引兜底） | 02BE §3.4 | done（2026-10-30 收口） |
| T14 | 聚合收口（参数序 tenant→filter→scope / 时间桶范围强制 / 超时熔断） | 02BE §3.6 | done（2026-10-30 收口） |
| T15 | 历史键保留（update 改 JSONB merge——DELETED 字段键永不移除） | 02BE §2.4 | done（2026-10-30 收口） |
| T16 | 错误码映射：FIELD_DELETED/PAGE_TOO_DEEP/RECORD_NOT_FOUND/VALIDATION_FAILED/PREVIEW_WRITE_DENIED/PREVIEW_SCOPE_DENIED | 02BE §A.6 | done |
| T17 | PromoteTaskConsumer（代理调用 REQUIRES_NEW + CAS 抢占判行数 + 索引补建 + immutable 修正） | 02BE §4 | done（2026-10-30 收口） |

## 2. 验收记录

### DataEngineIT（基础链路，11 用例）
- [x] SQL 注入三维度拦截 —— injectionBlockedOnFieldOperatorValue
- [x] DELETED 字段任何参数组合不可读 —— deletedFieldUnreachableByAnyParamCombo
- [x] 读时兼容 _invalid —— legacyRowMarkedInvalidNotThrown
- [x] 租户隔离 —— crossTenantInvisible
- [x] SELF 行级权限口径 —— selfScopeFiltersRows
- [x] 聚合权限一致 —— aggregateRespectsRowScope
- [x] 聚合分组 topN —— aggregateGroupAndTopN
- [x] 聚合护栏（非法函数 400） —— aggregateGuardrails
- [x] 深分页拒绝 —— deepPageRejected
- [x] CRUD 全链 —— createAndUpdateFlow
- [x] 未定义字段静默剔除 —— requiredFieldRejected

### DataEngineSecurityIT（收口缺口场景，2026-10-30 新增 13 用例）
- [x] **字段权限授权集**：已配置模型仅授权字段可见、不可编辑字段提交被静默忽略（现值保留） —— fieldPermGrantsOnlyAuthorizedFields
- [x] **未配置模型全可见**（不锁死） —— fieldPermUnconfiguredModelAllVisible
- [x] **DEPT 真实部门上下文**：仅见本部门行 + 无部门用户默认拒绝 —— deptScopeFiltersByRealDeptContext
- [x] **DEPT_TREE 子树可见 + 租户条件 + 树外拒绝** —— deptTreeScopeIncludesSubtreeWithTenantCondition
- [x] **只读预览写入拒绝 + allowRealWrite 放行** —— previewReadOnlyWriteDenied
- [x] **限页预览模型范围拒绝** —— previewPageBoundModelScope
- [x] **写入校验链**：类型/范围/枚举/必填/日期 —— writeValidationChain
- [x] **更新清空必填拒绝** —— updateRequiredCannotBeCleared
- [x] **历史键保留**：DELETED 字段值不因更新丢失、读面不透出 —— deletedFieldHistoryKeyPreservedOnUpdate
- [x] **批量 upsert**：插入/同键更新/上限拒绝 —— batchUpsertInsertAndUpdate
- [x] **唯一性不泄露权限外数据** —— uniqueCheckDoesNotLeakOutOfScope
- [x] **聚合 SELF+filter 参数对齐**（SUM 恰为自己可见值） —— aggregateSelfScopeWithFilterParamsAligned
- [x] **时间桶范围强制 + WEEK ISO 周界** —— timeBucketRequiresRangeAndWeekBoundary

## 3. 设计决策与妥协

- **模块解耦**：MetadataPort/DataPermissionPort/DataVolumePort 端口在消费方 domain，进程内适配器直连（bootstrap 组合根背书）；拆分后换 RPC 实现端口不变。
- **建模建表双链路**：Spring 事件同事务直连（强一致主路径）+ Outbox 补偿登记（重启/遗漏后幂等补建）——M2 尾项闭环。
- **CUSTOM_EXPR MVP 受限形态**：仅 `fieldKey op ${currentUserId|currentUserDeptId}` 二元比较；危险词黑名单 + 结构正则白名单双闸，不匹配一律拒绝（宁拒勿放）。
- **种子管理员通配范围**：V6 给 userId=1 建 seed_data_admin + model_id=0 的 ALL 范围；测试类 warmup 幂等自愈该种子（历史库可能缺失）。
- **无范围授权 = 默认拒绝（1=0）**；无部门上下文的 DEPT/DEPT_TREE/CUSTOM_EXPR(dept) 同判拒绝（不退化放宽）。
- **字段权限授权集语义**：sys_role_permission 的 FIELD 行 action 列编码字段键（visible:<fieldKey>——真源表无独立键列）；未配置任何 FIELD 行 = 全可见/全可编辑。
- **date 提升列不做 timestamptz 转换**：`(x)::timestamptz` 是 stable 非 immutable，GENERATED STORED 列被 PG 拒绝；date 字段提升列落地为 text、范围比较恒走 JSONB 表达式（fieldExpr 只对 number/boolean/text 判 promoted）。
- **唯一约束真源是 UNIQUE 部分索引**：`(tenant_id, col) WHERE deleted_at IS NULL AND col IS NOT NULL`——逻辑删除释放唯一值；应用层预检（注入行级范围）只是快速反馈层，TOCTOU 由索引兜底。
- **update 用 JSONB merge（data || ?::jsonb）**：只覆盖待写键——DELETED 字段历史键与未知键天然保留（02BE §2.4 键永不移除的字面实现）。
- **聚合超时熔断**：jdbc.setQueryTimeout(10s) + finally 重置；AGG_TIMEOUT 错误码引导缩小范围。
- **提升列并发**：poll() 经 @Lazy 自代理调 consumeOne()（同类直调绕过 Spring 代理是 M5 审查真实缺口）；CAS 抢占判受影响行数，BUILDING/重试耗尽不误置 FAILED；列残留（DuplicateKey already exists）走 ensurePromotedIndex 补建。

## 4. 延后项登记

- **DataLoader 批量关联拼装**（§2.3 防 N+1）：relationDepth 参数已入协议，拼装逻辑随 M6 渲染引擎的真实 relation 消费落地（relation 存在性校验已先行接线——批量收集目标集防逐行查询）。
- **批量导入导出**（§7）：P2 分期（/batch upsert 已提供原子导入底座）。
- **X-Suggest-Index 引导**：性能护栏随压测阶段（M16）接入（超时熔断已落地）。
- **游标分页（keyset）**：深分页拒绝已落地，cursor 协议随前端列表虚拟滚动需求排期。
- **Redis 元数据三级缓存**：单租户单体态进程内直查即可，随拆分/多租户性能需求启用。
- **record.created/updated/deleted 领域事件**（§3.4 第 6 步）：Outbox 表已建（V7）+ 本地投递桥已通；Kafka 化（ddl.promote/record.* topic）随事件基建分期。
- **computed PERSISTED 字段写入重算**：表达式引擎复用 M1 后端 ExprEngine，随 M6 计算字段真实启用接线。
- **桶数精确跨度换算**：当前以「必须显式范围」拦无限桶；精确跨度→桶数上限校验随 M6 查询规划接入。

## 5. 教训沉淀（2026-10-30 收口）

- ⚠️ **权限语义错位是静默失效**：适配器返回动作字符串集合被引擎当「不可见键集」用——字段权限从未生效且测试全绿（空集语义掩盖）。语义层（授权集 vs 拒绝集）必须在端口契约注释里写死，空集二义性用显式 hasConfig 消解。
- ⚠️ **PG JDBC `?` 占位符陷阱**：`data ?| ARRAY[...]` 的 `?|` 操作符会被驱动解析为占位符——必须双写 `??|`；数组字面量用单引号（双引号是标识符）。
- ⚠️ **date 与 timestamptz 无隐式转换**：`(data->>'k')::timestamptz >= ?` 传 varchar 参数报 operator does not exist——比较值必须转 java.sql.Timestamp 类型化参数（normalizeValue 按 field_type 分派）。
- ⚠️ **GENERATED STORED 列表达式必须 immutable**：`::timestamptz` 依赖会话时区是 stable——PG 直接拒绝建列，且此类错误只在真实建列时暴露（元数据校验层不可见）。
- ⚠️ **同类 @Transactional 自调用绕过代理**：poll() 直调 consumeOne() 时 REQUIRES_NEW 不生效（无新事务）——必须 @Lazy 注入自身经代理调用。
- ⚠️ **测试 warmup 别删种子数据**：`DELETE FROM sys_role WHERE id > 1` 连种子角色一起删，跨测试类连锁失败且报错点远离根因（表现为莫名 RECORD_NOT_FOUND）——清理一律按业务前缀过滤 + 种子幂等自愈。
- ⚠️ **ISO 周界**：date_trunc('week') 周一起点——10-05（周一）与 10-11（周日）同周；写周界断言前先对日历。
