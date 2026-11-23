---
spec_id: 021-flow-execution-minimal
status: draft
milestone: M18             # 依赖图 Phase 2「流程引擎」（05BE/10FE 分期声明）；020 阶段 A 已冻结输入契约
created: 2026-11-20
last_verified_at: null
owner: human-lead
---

# Spec · 完整流程阶段 B：后端最小执行链（开始→单级审批→结束）

## 1. 背景与目标（为什么做）

- **需求来源**：spec 016 §12 A 表「完整流程」裁决的阶段推进——A 流程只读展示（spec 020，已完成合并）→
  **B 后端最小执行** → C 前端设计办理。本 spec 只覆盖阶段 B。
- **真源依据（重要口径）**：完整流程 B/C 以《详细技术文档 05》（05BE——Flowable 接入/Transpiler/
  实例任务/事务边界）与《详细前端技术文档 10》（10FE——阶段 C 主依据）为设计依据；
  **spec 020 只是阶段 A 已冻结的输入契约（七型协议 + 三模式审批人），不能当作完整流程执行规格**。
  已冻结的大写七型 `FLOW_NODE_TYPES`（START/END/APPROVAL/CC/CONDITION_BRANCH/PARALLEL_GATEWAY/
  MERGE_GATEWAY）与三模式 `APPROVER_RULE_MODES`（USER/DEPT_ROLE/INITIATOR_SUPERVISOR）位于
  `packages/schema-protocol/src/types.ts`，是本 spec 的**代码输入真源**——不得按 10FE §2.1 旧草案
  （小写八型 + 六规则）重新定义一套。05BE 的 Phase 2 全量形态（动作节点/触发器/撤回/转办等）保留为目标态参考。
- **现状**：`flow-module` 仅有包结构占位（package-info）；05BE 明确 flow-service 整体 Phase 2 交付，
  本 spec 是其**最小可执行切片**——单级审批闭环跑通即达成本阶段目标。
- **不做会怎样**：020 只读画布永远消费演示 fixture；阶段 C 设计办理无真实后端可接。

## 2. 范围声明（做什么/不做什么）

**做**（阶段 B = 后端最小执行链，唯一支持拓扑：START → APPROVAL×1 → END）：

1. **执行契约冻结**：定义（Definition）/发布版本/实例（Instance）/任务（Task）DTO 与错误码；
   审批人解析语义、拒绝去向、业务状态、幂等键逐项定义（§3）。
2. **本期支持节点集显式枚举**：`['START','END','APPROVAL']`。协议允许但本期不支持的节点
   （CC/CONDITION_BRANCH/PARALLEL_GATEWAY/MERGE_GATEWAY）**发布时明确拒绝并返回逐节点错误**，
   不静默忽略、不降级执行。
3. **定义保存与部署**：租户内保存（FlowSchema 校验——复用前端 `validateFlowSchema` 同构逻辑）、
   版本发布（Flowable deployment）、发布版本不可变；在途实例按发起时 deployment 继续执行
   （05BE §2.3 长期行为）。
4. **Transpiler 最小映射**：START→StartEvent、APPROVAL→UserTask（assignee 留空，TaskListener
   运行时解析三模式）、END→EndEvent（含结束通知发起人）；驳回按 05BE §6 语义映射。
5. **实例与任务**：发起（含重复发起控制）、待办/已办查询、详情聚合（节点轨迹）、同意/拒绝办理；
   任务归属校验、并发办理控制（乐观锁/唯一约束）、幂等键。
6. **业务绑定**：`flow_instance_biz` 绑定模型+记录（05BE §5），同记录同流程 RUNNING 唯一索引
   拒绝并发发起；业务状态更新走明确事务边界（发起/办理与业务记录状态变更同一事务或 Outbox，见 T4）。
7. **通知与审计**：复用 notification-module（12-通知服务.md——FLOW_TODO/FLOW_DONE 模板、
   NotificationFacade RPC、尽力而为边界：待办列表为准不依赖通知推进状态）；
   `flow_task_log` 记录办理人/操作/意见/时间；token 不进入流程变量或表达式求值环境。
8. **真实 PG + Flowable 集成验收**（本地无 Docker——用线上 IT 库跑 IT，同 spec 016/018 先例）。

**不做**（推迟去向逐条写明）：

- 多级审批（APPROVAL×N 串联）/条件分支/并行会签执行 → 阶段 B2 或以后（按 05BE §2.1 逐节点扩展）；
- CC 抄送执行、动作节点（CALL_API/WRITE_DATA/NOTIFY ServiceTask）→ 05BE Phase 2 全量态，另行 spec；
- 转办/加签/撤回/催办/超时升级（05BE §6 表）→ 后续 spec（催办依赖 Redis 频控，随通知通道扩展）；
- 触发器（表单提交自动发起/CRON 定时，05BE §7）→ 本期只保留手动发起接口，TRIGGER_FLOW 动作
  接线属阶段 C；
- 审批人为空兜底三策略（05BE §3 emptyStrategy）→ 本期固定 BLOCK：解析为空即实例挂起+告警，
  FORWARD_ADMIN/AUTO_PASS 推迟；
- 前端流程编辑/发布 UI、待办/已办页面、审批中心 → 阶段 C（spec 022）；
- 表单提交自动触发流程（保留既有报销登记模式，不动）→ 阶段 C 接通。

## 3. 接口契约（对外的稳定承诺）

> 阶段 B 新增路由全部挂 `/api/flows*`、`/api/my/tasks*`、`/api/tasks*`（05BE §A 命名空间）。
> 输入 FlowSchema 结构以 schema-protocol 代码真源为准（020 冻结版），后端 DTO 与前端类型同构。

### 3.1 流程定义（05BE §A.1 子集）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/flows?appId=` | — | `{list:[{id, name, flowKey, status, version, updatedAt}]}` |
| POST | `/api/flows` | `{appId, name, flowSchema}` | `{id}`（保存即草稿，校验不过 422 逐节点错误） |
| PUT | `/api/flows/{id}/draft` | `{flowSchema, baseVersion}` | `{version}` 或 `409 {serverVersion}` |
| POST | `/api/flows/{id}/publish` | — | `{version}`；发布校验：本期节点集外类型逐节点拒绝（错误码 `NODE_TYPE_NOT_SUPPORTED`） |
| GET | `/api/flows/{id}` | — | `{id, name, flowKey, status, version, flowSchema}` |

- 定义状态机：`DRAFT → PUBLISHED →（新版本发布）PUBLISHED(v+1)`；发布不可变（不改已发布版本内容，
  只能发新版本）；停用接口本期不做（推迟）。
- **发布即部署**：发布时 Transpiler 生成 BPMN XML → Flowable deployment（版本递增）；
  dry-run 校验失败（结构/映射错）422 阻断。

### 3.2 实例与任务（05BE §A.2 子集）

| 方法 | 路径 | 请求/说明 | 响应 |
|---|---|---|---|
| POST | `/api/flows/{defId}/instances` | `{modelId, recordId}`；发起权限校验（03BE「发起」action）；同记录同流程 RUNNING 唯一索引拒绝 409 | `{instanceId}` |
| GET | `/api/flows/instances?modelId=&recordId=` | 业务记录关联实例 | `{list:[{instanceId, flowDefId, status, startedAt}]}` |
| GET | `/api/flows/instances/{instanceId}` | 详情聚合（审批时间线数据源） | `{status, startedBy, startedAt, nodes:[{nodeId, name, state, assignees[], operatedAt?}], taskLog[]}` |
| GET | `/api/my/tasks?status=TODO\|DONE&page=&size=` | 我的待办/已办 | `{list:[{taskId, instanceId, flowName, bizTitle, nodeId, createdAt}], total, page, size}` |
| POST | `/api/tasks/{taskId}/complete` | `{approve:boolean, comment}` | 同意推进/拒绝终止；意见必填 422；归属校验 403；并发办理 409 |
| POST | `/api/tasks/{taskId}/transfer` | `{targetUserId}` | 转交（05BE §6）——**本期不做**（契约占位，返回 501） |

- 节点状态枚举与 020 前端 `InstanceNodeState` 对齐：`PENDING/ACTIVE/DONE/SKIPPED`。
- 详情 `nodes[]` 从 Flowable HistoryService 节点轨迹聚合（05BE §5 数据流）。

### 3.3 审批人解析（三模式——020 冻结真源）

```
USER                → userIds 逐个解析（不存在/停用成员剔除，剩空走 BLOCK）
DEPT_ROLE           → 发起人所在部门 × roleKeys 匹配成员（03BE 组织架构查询）
INITIATOR_SUPERVISOR → 发起人直属上级（iam 组织树）；缺失时 fallbackUserIds；仍空走 BLOCK
解析时机：TaskListener 实时解析（05BE §3——组织调整无需改定义）
为空策略：BLOCK（实例挂起 SUSPENDED + notification 告警，运营可查）——本期唯一策略
```

- 审批人上下文变量（发起人 id/deptId、表单快照）经流程变量传入，但**表达式求值不在本期范围**
  （三模式均不消费 ExpressionBinding）；token 永不入流程变量。

### 3.4 拒绝语义与业务状态

- 拒绝（approve=false）→ 流程直接终止（单级拓扑无回退目标）→ 实例 FINISHED、业务状态置驳回态；
- 同意 → 推进至 END → 实例 FINISHED、业务状态置通过态；
- 业务状态更新：`POST /complete` 事务内直接更新业务记录 status 字段（data-module 表快照字段，
  简化实现——不走 Outbox，本期无跨服务异步消费方）；失败回滚流程操作与业务写入。
- 幂等键：`taskId`（Flowable 任务级天然幂等——complete 后任务不存在，重复办理 404/409）；
  发起幂等：`(model_id, record_id, flow_def_id)` 活跃实例唯一索引（05BE §5 DDL 原样落地）。

### 3.5 DDL（Flyway 新版本号——对齐既有迁移序号）

```sql
-- flow_definition / flow_instance_biz / flow_task_log（05BE §5 + §6 字段）
CREATE TABLE flow_definition (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL, app_id BIGINT NOT NULL,
  flow_key VARCHAR(64) NOT NULL, name VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL,                  -- DRAFT / PUBLISHED
  version INT NOT NULL DEFAULT 1,
  flow_schema JSONB NOT NULL,
  deployment_id VARCHAR(64),                    -- 发布后 Flowable deployment
  created_by BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, app_id, flow_key)
);
CREATE TABLE flow_instance_biz (
  id BIGSERIAL PRIMARY KEY,
  instance_id VARCHAR(64) NOT NULL,             -- Flowable processInstanceId
  tenant_id BIGINT NOT NULL, model_id BIGINT NOT NULL, record_id BIGINT NOT NULL,
  flow_def_id BIGINT NOT NULL, started_by BIGINT NOT NULL, started_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(16) NOT NULL,                  -- RUNNING / FINISHED / TERMINATED / SUSPENDED
  UNIQUE (instance_id)
);
CREATE UNIQUE INDEX uq_flow_active ON flow_instance_biz(model_id, record_id, flow_def_id)
  WHERE status IN ('RUNNING','SUSPENDED');
CREATE TABLE flow_task_log (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL, task_id VARCHAR(64) NOT NULL, instance_id VARCHAR(64) NOT NULL,
  node_id VARCHAR(64) NOT NULL, action VARCHAR(16) NOT NULL,  -- COMPLETE / REJECT / AUTO
  operator_id BIGINT NOT NULL, comment TEXT, operated_at TIMESTAMPTZ NOT NULL
);
```

- Flowable 自身表（ACT_*）由 Flowable 自动建表（`database-schema-update=true` 线上库执行一次）。
- 业务状态字段：报销模型既有表加 `flow_status` 列（NULL=未发起流程）——复用 data-module 既有
  业务表机制，不新建状态表。

### 3.6 错误码（本域新增）

| code | HTTP | 场景 |
|---|---|---|
| `NODE_TYPE_NOT_SUPPORTED` | 422 | 发布时含本期不支持节点（CC/CONDITION_BRANCH/...），逐节点定位 |
| `INSTANCE_ALREADY_RUNNING` | 409 | 同记录同流程唯一索引拒绝（05BE §A.3 原样） |
| `COMMENT_REQUIRED` | 422 | 审批意见必填（05BE §A.3 原样） |
| `TASK_ALREADY_COMPLETED` | 409 | 并发办理：任务已被他人完成（幂等键冲突） |
| `TASK_NOT_ASSIGNED` | 403 | 任务归属校验失败（非候选人/非受理人） |
| `FLOW_DEF_NOT_PUBLISHED` | 409 | 对未发布定义发起实例 |
| `ASSIGNEE_EMPTY_BLOCKED` | 500→实例态 | 审批人解析为空 → 实例 SUSPENDED + 告警（不抛调用方） |

## 4. Tasks（任务清单，执行时逐项勾选）

- [ ] T1 契约与 DTO 冻结：FlowDefinitionDto/FlowInstanceDto/FlowTaskDto + 错误码常量入
      flow-module；与 schema-protocol FlowSchema 同构镜像（Java record，同 ExprVectorTest 先例
      的共享真源校验思路——FlowSchema fixture 双端同判）。
- [ ] T2 DDL + Flowable 接入：Flyway 迁移（§3.5）+ flow-module 引 Flowable-Spring-Boot-Starter
      （process 依赖）；本地零 Docker——线上 IT 库先建表，IT 用 `VERIFY_IT_DB_*` 隧道先例。
- [ ] T3 Transpiler 最小实现：FlowSchema（校验过）→ BPMN XML（START/APPROVAL/END 映射）；
      发布校验链（结构复检 + 本期节点集白名单 + dry-run 部署）；单测覆盖七型中四型拒绝 +
      三型编译通过。
- [ ] T4 定义服务：保存（草稿）/发布（部署+版本不可变）/列表/详情；409 baseVersion 乐观锁。
- [ ] T5 实例与任务服务：发起（权限校验+唯一索引）、待办/已办、详情聚合（HistoryService）、
      办理（同意/拒绝 + 事务边界：complete 与业务状态更新同一事务）；任务归属校验。
- [ ] T6 审批人解析 TaskListener：三模式 + BLOCK 策略（挂起+告警）；token 不入变量（测试断言）。
- [ ] T7 通知与审计接线：NotificationFacade（FLOW_TODO 待办/FLOW_DONE 结果）+ flow_task_log
      全量记录；尽力而为边界（通知失败不影响办理）。
- [ ] T8 集成验收（线上 PG + Flowable）：§5 全部 Acceptance 落为 IT 用例。

## 5. Acceptance（验收标准，可测试）

- [ ] A1 `verify -Level commit` 通过（含 backend-it 步骤——线上隧道库跑 IT）。
- [ ] A2 合法流程（START→APPROVAL→END）定义→发布→发起→待办查询→同意→实例 FINISHED 全链路 IT 通过。
- [ ] A3 越权办理（非候选人 complete）403 `TASK_NOT_ASSIGNED`；跨租户访问定义/实例 404/403。
- [ ] A4 同一任务并发办理：两请求只有一个成功，另一个 409 `TASK_ALREADY_COMPLETED`；实例无重复推进。
- [ ] A5 重复发起：同记录同流程第二实例被唯一索引拒绝 409 `INSTANCE_ALREADY_RUNNING`。
- [ ] A6 新版本发布后，在途实例继续按旧 deployment 执行完毕；新发起走新版本。
- [ ] A7 含不支持节点（如 CONDITION_BRANCH）的定义发布被 422 `NODE_TYPE_NOT_SUPPORTED`
      逐节点拒绝，不产生 deployment。
- [ ] A8 拒绝办理：实例 FINISHED（终止语义）、业务记录 flow_status=驳回、发起人收到 FLOW_DONE_REJECTED 通知。
- [ ] A9 审批人解析为空（DEPT_ROLE 无匹配成员）→ 实例 SUSPENDED + 运营告警产生；恢复成员后
      不自动复活（人工重试入口属后续——本期记录待办描述）。
- [ ] A10 失败注入：complete 事务内业务状态更新失败 → 流程操作与业务写入全部回滚，无任务丢失。
- [ ] A11 Flowable ACT_* 表只在发布/实例链路写入；无定义的裸流程操作被拒（无孤儿实例）。
- [ ] A12 token/会话凭证不出现于流程变量、TaskListener 上下文（IT 断言变量集合）。

## 6. 验证步骤（人可复跑）

```text
1. pnpm --filter @schema/schema-protocol test          # 协议真源回归（七型/三模式不变）
2. powershell -File scripts\verify.ps1                  # 含 backend-it（线上隧道 PG）
3. IT 链路：mvn -pl flow-module -am test（或 verify.ps1 backend-it 步骤）
4. 人工冒烟（线上验收后端）：curl 发起→查待办→同意→查实例状态 FINISHED
```

## 7. 沉淀记录（结项时回填）

- <待结项回填：Transpiler 映射坑 / Flowable 版本与 PG 兼容 / 唯一索引并发行为等>

## 8. 开工契约校准（2026-11-20 评审定版）

- **代码真源优先序**：执行契约以 05BE §A 为蓝本、以 schema-protocol 020 冻结版为输入结构真源；
  二者冲突时（如 ApproverRule 六规则 vs 三模式）以代码真源为准并在本 spec 登记（§3.3 已按三模式定版）。
- **支持节点集诚实枚举**：协议七型 ≠ 执行端全支持——本期仅 START/END/APPROVAL，其余四型发布拒绝；
  后续扩节点必须先扩本 spec 的支持集与 Transpiler 映射，禁止「协议有定义即宣称执行支持」。
- **授权范围（需人类负责人确认后开工）**：
  1. flow-module 新增 Maven 依赖 `org.flowable:flowable-spring-boot-starter-process`（7.x，JDK21 兼容）；
  2. Flyway 新迁移版本（flow_definition/flow_instance_biz/flow_task_log 三表 + 报销表 flow_status 列）；
  3. Flowable 自动建表开关在**线上 IT 库**开启（schema_it——专用受限账号，与验收/生产库隔离）；
     生产/验收库的 ACT_* 建表与迁移发布节奏另行评审（不随本 spec 自动下发）；
  4. 业务状态写入采用 complete 同事务直更（不走 Outbox）——已在 §3.4 定版，若后续引入异步消费方须重评。
