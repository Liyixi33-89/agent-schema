# Flowable 启用影响清单（IT 库）

> 对应 spec 021 §8 授权第 3 条：Flowable 自动建表开关**仅在线上 IT 库**开启，
> 生产/验收库不随本 spec 下发。
>
> 数据来源：直接从项目依赖的 jar 里提取真实 DDL（非文档、非记忆）——
> `flowable-*-7.2.0.jar` 内 `org/flowable/**/db/create/flowable.postgres.create.*.sql`

## 1. 影响范围一句话

| 项 | 结论 |
|---|---|
| 新增表 | **32 张**（全部 `ACT_*` / `FLW_*` 前缀，与业务表无命名冲突） |
| 新增索引 | **约 130 个** |
| 修改既有表 | **无** —— Flowable 只建自己的表，不触碰 `flow_*` / `sys_*` / `page` 等 |
| 预期容量 | 空库启动约 2-5 MB；后续随实例数增长 |
| 首次启动耗时 | 数秒（32 表 + 索引，PG 本机） |

## 2. 表清单（按来源 SQL 分组）

### 2.1 `flowable.postgres.create.common.sql` —— 20 张

```
ACT_GE_PROPERTY            ACT_GE_BYTEARRAY
ACT_RU_ENTITYLINK          ACT_HI_ENTITYLINK
ACT_RU_IDENTITYLINK        ACT_HI_IDENTITYLINK
ACT_RU_JOB                 ACT_RU_TIMER_JOB
ACT_RU_SUSPENDED_JOB       ACT_RU_DEADLETTER_JOB
ACT_RU_HISTORY_JOB         ACT_RU_EXTERNAL_JOB
FLW_RU_BATCH               FLW_RU_BATCH_PART
ACT_RU_TASK                ACT_HI_TASKINST
ACT_HI_TSK_LOG             ACT_RU_VARIABLE
ACT_HI_VARINST             ACT_RU_EVENT_SUBSCR
```

### 2.2 `flowable.postgres.create.engine.sql` —— 7 张

```
ACT_RE_DEPLOYMENT          ACT_RE_MODEL
ACT_RE_PROCDEF             ACT_PROCDEF_INFO
ACT_RU_EXECUTION           ACT_RU_ACTINST
ACT_EVT_LOG
```

（三文件合计 20 + 7 + 5 = **32 张**，无重复——已用脚本按 `create table` 语句逐条核对）

### 2.3 `flowable.postgres.create.history.sql` —— 5 张

```
ACT_HI_PROCINST            ACT_HI_ACTINST
ACT_HI_DETAIL              ACT_HI_COMMENT
ACT_HI_ATTACHMENT
```

### 2.4 不会创建的表（IDM 已关闭）

`flowable.postgres.create.identity.sql` 含 **9 张 `ACT_ID_*` 表**
（`ACT_ID_USER` / `ACT_ID_GROUP` / `ACT_ID_MEMBERSHIP` / `ACT_ID_INFO` /
`ACT_ID_TOKEN` / `ACT_ID_PROPERTY` / `ACT_ID_BYTEARRAY` / `ACT_ID_PRIV` / `ACT_ID_PRIV_MAPPING`）。

本项目的配置已显式关闭 IDM：

```yaml
flowable:
  idm:
    enabled: false
```

→ **这 9 张表不会建**。若要启用 Flowable 内置用户体系（本 spec 不需要，
用户体系走 iam-module），才需打开 `flowable.idm.enabled`。

## 3. 关键表的业务含义（排查时会用到）

| 表 | 含义 | 本 spec 是否写入 |
|---|---|---|
| `ACT_RE_DEPLOYMENT` | 每次发布的部署记录 | ✅ 发布时写 |
| `ACT_RE_PROCDEF` | 流程定义（版本化） | ✅ 发布时写 |
| `ACT_RU_EXECUTION` | 运行中实例的执行树 | ✅ 发起时写 |
| `ACT_RU_TASK` | **待办任务**（`/api/my/tasks` 的数据源） | ✅ 办理时写 |
| `ACT_HI_PROCINST` | 历史实例（实例详情聚合） | ✅ 全程写 |
| `ACT_HI_ACTINST` | 节点轨迹（详情页时间线） | ✅ 全程写 |
| `ACT_HI_TASKINST` | 历史任务（已办查询） | ✅ 全程写 |
| `ACT_GE_PROPERTY` | **引擎版本标记**（探测用） | 引擎自身维护 |
| `ACT_ID_*` | IDM 用户体系（9 张） | ❌ 不创建 |

## 4. 版本标记（探测与幂等判断依据）

建表完成后 `ACT_GE_PROPERTY` 会有两条关键记录：

```
NAME_ = 'schema.version'   VALUE_ = '7.2.0.2'
NAME_ = 'schema.history'   VALUE_ = 'create(7.2.0.2)'
```

⚠️ **列名带下划线后缀**（`NAME_` / `VALUE_` / `REV_`）——
写成 `name` / `value_` 会直接报「列不存在」。已核对真实 DDL：

```sql
create table ACT_GE_PROPERTY (
    NAME_ varchar(64),
    VALUE_ varchar(300),
    REV_ integer,
    primary key (NAME_)
);
```

用途：
- 探测脚本据此判断「是否已初始化」
- 若版本 ≠ `7.2.0.2`，说明该库装的是其它 Flowable 版本，**不能直接删表重建**（需走官方升级脚本）

## 5. 与业务表的关系

```
业务侧（本项目 Flyway 管理）
  flow_definition      定义 + flow_schema(JSONB) + deployment_id
  flow_instance_biz    instance_id ←→ (model_id, record_id) 业务绑定
  flow_task_log        办理审计（谁/何时/同意或拒绝/意见）

Flowable 侧（引擎自动建表）
  ACT_*                引擎内部状态（执行树/任务/历史/变量）
  FLW_RU_BATCH         批处理（本期不用）

关联键：flow_instance_biz.instance_id = ACT_RU_EXECUTION.PROC_INST_ID_
关联键：flow_definition.deployment_id = ACT_RE_DEPLOYMENT.ID_
```

**关键设计**：业务表存「业务语义」（哪条记录、谁发起、审批意见），
Flowable 表存「引擎状态」。两侧用 id 关联，互不侵入——
这样将来若替换流程引擎，业务侧数据不丢。

## 6. 启用步骤（执行顺序）

```bash
# ① 只读探测（先跑这个，确认库状态）
bash scripts/flow/flow-probe-readonly.sh <db_name> <db_user>

# ② 备份（即使探测显示干净库也要做——不可回滚的操作必须先有退路）
pg_dump -h 127.0.0.1 -U <user> -F c -f /path/backup_before_flowable_$(date +%F).dump <db_name>

# ③ 启用（环境变量方式，不改代码）
FLOWABLE_ENABLED=true java -jar ...   # 或写进该环境的 application-*.yml

# ④ 验证建表
bash scripts/flow/flow-probe-readonly.sh <db_name> <db_user>
# 期望：32 张表，schema.version = 7.2.0.2
```

## 7. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 建表失败中途退出 | 库里有部分表 | Flowable 用事务+`ACT_GE_LOCK`，失败自动回滚；重跑前先跑探测 |
| 误在**生产库**开启 | 生产库多 32 张表 | 默认 `FLOWABLE_ENABLED=false`；仅 IT 环境显式设 `true` |
| 版本不匹配 | 启动报 schema 版本错 | 探测脚本先核对 `schema.version`；不匹配走官方升级脚本 |
| 空间不足 | 建表失败 | 探测脚本报告库大小与磁盘余量 |
| 删表重建 | **数据永久丢失** | 严禁 `DROP TABLE ACT_*`；见回滚方案 §3 |