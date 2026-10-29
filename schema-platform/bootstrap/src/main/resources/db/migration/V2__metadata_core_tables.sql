-- M2.1 元数据服务核心表（01BE §2）
-- 铁律：永不 DROP COLUMN，字段/模型只做逻辑删除（01BE §3）

-- 模型表
CREATE TABLE meta_model (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL,
  app_id          BIGINT NOT NULL,
  model_key       VARCHAR(64) NOT NULL,
  name            VARCHAR(128) NOT NULL,
  icon            VARCHAR(64),
  status          VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE / DELETED / ARCHIVED
  deleted_at      TIMESTAMPTZ,
  current_version INT NOT NULL DEFAULT 1,
  created_by      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, app_id, model_key)
);
CREATE INDEX idx_meta_model_tenant ON meta_model(tenant_id, status);

-- 字段元数据表（核心）：行永不物理删除，field_status 置 DELETED
CREATE TABLE meta_field (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL,
  model_id      BIGINT NOT NULL,
  field_key     VARCHAR(64) NOT NULL,
  label         VARCHAR(128) NOT NULL,
  field_type    VARCHAR(32) NOT NULL,   -- 12 种协议枚举 code（textarea/datetime 为控件配置不进枚举）
  field_status  VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  deleted_at    TIMESTAMPTZ,
  required      BOOLEAN DEFAULT FALSE,
  unique_flag   BOOLEAN DEFAULT FALSE,
  indexed       BOOLEAN DEFAULT FALSE,  -- 是否提升列
  promote_status VARCHAR(16),           -- NULL / PENDING / BUILDING / ACTIVE / FAILED
  default_value JSONB,
  validators    JSONB,
  enum_options  JSONB,
  relation_config JSONB,
  computed_config JSONB,
  sort_order    INT NOT NULL DEFAULT 0,
  schema_version INT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (model_id, field_key)
);
CREATE INDEX idx_meta_field_model ON meta_field(model_id, field_status);

-- 关系定义（n:n 中间表登记）
CREATE TABLE meta_relation (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  model_a_id BIGINT NOT NULL,
  model_b_id BIGINT NOT NULL,
  cardinality VARCHAR(8) NOT NULL,      -- '1:1','1:n','n:n'
  field_id BIGINT,
  cascade_strategy VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (model_a_id, model_b_id, field_id)
);

-- 版本快照表（每次保存一条；回滚产生的新版本标记 rollback_from）
CREATE TABLE meta_schema_version (
  id BIGSERIAL PRIMARY KEY,
  model_id BIGINT NOT NULL,
  version INT NOT NULL,
  snapshot JSONB NOT NULL,
  diff JSONB NOT NULL,
  operator_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rollback_from INT,
  UNIQUE (model_id, version)
);

-- 显式引用表（影响面分析主路径，01BE §4.5）
CREATE TABLE meta_field_reference (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  model_id BIGINT NOT NULL,
  field_key VARCHAR(64) NOT NULL,
  ref_type VARCHAR(16) NOT NULL,        -- PAGE / FLOW / SCRIPT / API_CONSUMER / COMPUTED
  ref_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (model_id, field_key, ref_type, ref_id)
);
CREATE INDEX idx_ref_field ON meta_field_reference(model_id, field_key);

-- 两段式确认 token 消费记录（01BE §4.2：一次性消费，TTL 10 分钟由应用层维护）
CREATE TABLE meta_confirm_token (
  token VARCHAR(64) PRIMARY KEY,
  model_id BIGINT NOT NULL,
  binding_hash VARCHAR(128) NOT NULL,   -- changes 摘要 / targetVersion 绑定
  base_version INT NOT NULL,            -- 保存场景 = baseVersion；回滚场景 = targetVersion
  confirm_mode VARCHAR(16) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_confirm_token_expires ON meta_confirm_token(expires_at);
