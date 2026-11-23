# Flowable 启用回滚方案（IT 库）

> 配合 `FLOWABLE-IMPACT.md` 使用。**执行任何回滚前先读 §0 的处置原则**——
> 大部分「想回滚」的场景其实不该删表。

## §0 先判断：属于哪一类，别急着删

| 场景 | 正确处置 | 是否删表 |
|---|---|---|
| **刚启用，还没跑过任何流程**（无实例） | 关 `FLOWABLE_ENABLED=false` 即可，表留着无害 | ❌ 不需要 |
| **跑过测试流程，想清空重来** | 见 §2 清理（保留表结构） | ❌ 只清数据 |
| **版本装错（≠7.2.0.2）** | 走 Flowable 官方升级脚本 | ❌ 严禁删表重建 |
| **确认整个 IT 库要废弃重建** | 见 §3（整库级操作） | ⚠️ 需人类负责人签字 |

**铁律**：`ACT_*` 表里有在途实例、历史轨迹、任务归属。直接 `DROP` 会让
「某条业务记录走了什么审批」永久丢失，且无法从 `flow_task_log` 完全还原
（引擎侧的节点轨迹/变量快照只存在 ACT_ 表）。

## §1 推荐回滚：只关开关（零损失）

适用：刚启用、或想让流程功能暂时停用。

```bash
# 修改该环境配置（不改代码）
FLOWABLE_ENABLED=false
```

效果：
- 应用启动不再装配 Flowable，不碰任何 ACT_* 表
- `flow_definition` / `flow_instance_biz` / `flow_task_log` **数据原样保留**
- 定义仍可正常增删改查（`NoopFlowDeploymentGateway` 只让「发布」失败）
- 重新开启后，既有 ACT_* 数据仍然可用

⚠️ 代价：已发布的流程无法发起新实例（发布时会明确报错，不会产生假状态）。

## §2 清空测试数据（保留表结构）

适用：IT 反复跑验收，想从干净状态开始。**不删表**，只清数据。

### 2.1 必须先确认无在途实例

```sql
-- 有结果就停下：说明有实例正在跑，清空会丢真实进度
SELECT COUNT(*) FROM act_ru_execution WHERE PARENT_ID_ IS NULL;
```

### 2.2 业务侧清理（按依赖顺序）

```sql
BEGIN;

-- ① 任务审计
DELETE FROM flow_task_log WHERE tenant_id = :tenant;

-- ② 实例绑定
DELETE FROM flow_instance_biz WHERE tenant_id = :tenant;

-- ③ 定义（deployment_id 先置空，避免与引擎侧引用不一致）
UPDATE flow_definition SET deployment_id = NULL WHERE tenant_id = :tenant;
DELETE FROM flow_definition WHERE tenant_id = :tenant;

COMMIT;
```

### 2.3 引擎侧清理（Flowable 官方 API 优先，不用手工 DELETE）

**优先用 API**——手工 DELETE 会破坏引擎内部一致性（例如 `ACT_GE_BYTEARRAY` 里
存着 BPMN 资源，漏删会留下孤儿字节数组）：

```java
// 按部署删除（级联清理该部署的定义、实例、历史）
repositoryService.deleteDeployment(deploymentId, true); // true = cascade
```

或按定义 key 批量：

```java
repositoryService.createDeploymentQuery()
    .deploymentName(processKey)
    .list()
    .forEach(d -> repositoryService.deleteDeployment(d.getId(), true));
```

### 2.4 何时才需要「清空全部引擎数据」

只有确认该库的**所有**流程实例都是测试数据时：

```sql
-- ⚠️ 危险：会丢失全部流程历史。执行前必须确认
SELECT COUNT(*) FROM act_hi_procinst;   -- 历史实例总数
SELECT COUNT(*) FROM act_ru_execution;  -- 运行中实例数（必须为 0）
```

即便此时，**推荐顺序仍是**：先用 API 逐个 `deleteDeployment(..., true)`，
确认 `act_re_deployment` 为空后再考虑整表清空。

## §3 整库级回滚（最后手段）

仅当 IT 库要完全废弃重建。**必须有负责人确认**。

### 3.1 备份（不可跳过）

```bash
pg_dump -h 127.0.0.1 -U <user> -F c \
  -f /path/itdb_before_drop_$(date +%Y%m%d_%H%M).dump <db_name>

# 校验备份可读（避免备了个坏文件还不知道）
pg_restore -l /path/itdb_before_drop_*.dump | head -20
```

### 3.2 如果坚持要删 Flowable 表

```sql
-- ⚠️⚠️ 仅在已备份、且确认无业务数据价值时执行
-- 不要手写 DROP 列表——用下面的生成式，避免漏表/错表
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND (tablename LIKE 'act\_%' OR tablename LIKE 'flw\_%')
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', r.tablename);
  END LOOP;
END $$;
```

为什么用生成式而非手写清单：手写 32 个表名极易漏，
漏掉的表会让后续重启时 Flowable 认为「部分已初始化」→ schema 版本校验失败，
比全新建表更难排查。

### 3.3 删后验证

```bash
bash scripts/flow/flow-probe-readonly.sh <db_name> <db_user>
# 期望：Flowable 表数量 = 0
```

## §4 回滚后重启用

```bash
FLOWABLE_ENABLED=true
```

首次启动会自动建 32 张表（幂等：已存在的表会被跳过，不会报错）。

**验证**：

```bash
bash scripts/flow/flow-probe-readonly.sh <db_name> <db_user>
# 期望：
#   已有 Flowable 表数量: 32
#   schema.version = 7.2.0.2
#   schema.history = create(7.2.0.2)
```

## §5 常见故障对照

| 现象 | 原因 | 处置 |
|---|---|---|
| 启动报 `SchemaManagementException` / 版本不匹配 | 库里有其它版本的 ACT_ 表 | 先探测版本；不可直接删，需官方升级脚本 |
| 启动卡住超过 30 秒 | `databaseSchemaUpdate` 正在建表 | 等待；PG 本机建 32 表通常 < 10 秒 |
| `relation "act_ge_property" does not exist` 但配置为 true | 建表被权限拒绝 | 探测脚本的 `has_database_privilege(...'CREATE')` 会提前暴露 |
| 发布报「引擎未启用」 | `FLOWABLE_ENABLED=false` | 按需开启；这是**预期行为**，不是 bug |
| 建表后某张 ACT_ 表缺失 | 上次建表中途失败 | 关开关 → 探测确认缺口 → 删残留（§3.2）→ 重开 |

## §6 与生产/验收库的边界

| 环境 | `FLOWABLE_ENABLED` | 说明 |
|---|---|---|
| 生产 `/opt/schema/current` | **false**（默认） | spec 021 §8：不随本 spec 下发 ACT_* 建表 |
| 验收 `/opt/schema/staging/accept` | **false**（默认） | 同上 |
| 线上 IT 库 | **true**（人工显式设置） | 本方案的目标环境 |
| CI 隔离 PG | true（CI 内临时库，随容器销毁） | 生命周期短，无回滚需求 |

⚠️ 生产/验收若将来要启用，**必须单独评审**建表窗口与备份策略，
不能复用本 IT 方案直接放开。