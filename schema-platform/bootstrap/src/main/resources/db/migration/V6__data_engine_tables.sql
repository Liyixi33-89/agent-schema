-- M5 数据引擎（02BE §2/§4）：物理表登记 + 提升列任务表
-- 业务数据物理表 biz_model_<model_id> 由 PhysicalTableManager 动态创建（建模时自动建表，
-- 每模型一张；表数量控制策略 02BE §2.2——共享表模式为 P2 分期）

-- 物理表登记（幂等建表的水位线；建表/提升列动作记录于此）
CREATE TABLE data_physical_table (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL,
  model_id      BIGINT NOT NULL,
  table_name    VARCHAR(128) NOT NULL,     -- biz_model_<model_id>
  status        VARCHAR(16) NOT NULL,     -- ACTIVE / DROPPED（逻辑停用——物理表永不 DROP COLUMN 但删模型可 DROP TABLE 归档）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, model_id)
);

-- 提升列任务（02BE §4：ddl.promote 消费端状态机 PENDING → BUILDING → ACTIVE/FAILED）
-- MVP 无 MQ：M2 collectPendingPromotions 置 PENDING 后由本服务扫描消费（轮询替代订阅，Kafka 随 M5 后事件基建）
CREATE TABLE data_promote_task (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL,
  model_id      BIGINT NOT NULL,
  field_key     VARCHAR(64) NOT NULL,
  status        VARCHAR(16) NOT NULL DEFAULT 'PENDING',  -- PENDING / BUILDING / ACTIVE / FAILED
  last_error    TEXT,
  attempts      INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (model_id, field_key)             -- 幂等键（02BE §4：重复任务直接 ACK）
);
CREATE INDEX idx_promote_pending ON data_promote_task(status) WHERE status IN ('PENDING','FAILED');

-- 种子管理员数据范围（userId=1 平台种子账号）：model_id=0 为全模型通配（02BE §3.3 ALL 范围）。
-- 生产态多租户由租户开通向导按模型建号授权；此种子仅为单租户 MVP 兜底。
INSERT INTO sys_role (tenant_id, app_id, code, name, role_type)
VALUES (1, 1, 'seed_data_admin', '种子数据管理员', 'TENANT')
ON CONFLICT DO NOTHING;
INSERT INTO sys_user_role (user_id, role_id)
SELECT 1, id FROM sys_role WHERE tenant_id=1 AND code='seed_data_admin'
ON CONFLICT DO NOTHING;
INSERT INTO sys_role_data_scope (role_id, model_id, scope_type)
SELECT id, 0, 'ALL' FROM sys_role WHERE tenant_id=1 AND code='seed_data_admin'
ON CONFLICT DO NOTHING;

