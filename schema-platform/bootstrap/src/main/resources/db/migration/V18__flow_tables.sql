-- M18 流程执行最小链（spec 021 §3.5 / 05BE §5-6）
-- 纪律：只增不改；三表 + 上报销模型 flow_status 列
-- ⚠️ Flowable 自身 ACT_* 表由 Flowable 自动建表（database-schema-update），
--    与下列业务表分离——本迁移只建业务侧三表。

CREATE TABLE flow_definition (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT       NOT NULL,
    app_id        BIGINT       NOT NULL,
    flow_key      VARCHAR(64)  NOT NULL,
    name          VARCHAR(128) NOT NULL,
    status        VARCHAR(16)  NOT NULL,               -- DRAFT / PUBLISHED
    version       INT          NOT NULL DEFAULT 1,
    flow_schema   JSONB        NOT NULL,
    deployment_id VARCHAR(64),                         -- 发布后 Flowable deployment id
    created_by    BIGINT       NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, app_id, flow_key)
);

CREATE TABLE flow_instance_biz (
    id          BIGSERIAL PRIMARY KEY,
    instance_id VARCHAR(64) NOT NULL,                  -- Flowable processInstanceId
    tenant_id   BIGINT      NOT NULL,
    model_id    BIGINT      NOT NULL,
    record_id   BIGINT      NOT NULL,
    flow_def_id BIGINT      NOT NULL,
    started_by  BIGINT      NOT NULL,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    status      VARCHAR(16) NOT NULL,                  -- RUNNING / FINISHED / TERMINATED / SUSPENDED
    UNIQUE (instance_id)
);

-- 同记录同流程只允许一个活跃实例（spec 021 §3.4 发起幂等 / 05BE §5 DDL 原样）
-- 部分唯一索引：仅对活跃态生效，历史实例不阻塞重新发起
CREATE UNIQUE INDEX uq_flow_active
    ON flow_instance_biz (model_id, record_id, flow_def_id)
    WHERE status IN ('RUNNING', 'SUSPENDED');

CREATE INDEX idx_flow_instance_record ON flow_instance_biz (tenant_id, model_id, record_id);

CREATE TABLE flow_task_log (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   BIGINT      NOT NULL,
    task_id     VARCHAR(64) NOT NULL,
    instance_id VARCHAR(64) NOT NULL,
    node_id     VARCHAR(64) NOT NULL,
    action      VARCHAR(16) NOT NULL,                  -- COMPLETE / REJECT / AUTO
    operator_id BIGINT      NOT NULL,
    comment     TEXT,
    operated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_flow_task_log_instance ON flow_task_log (tenant_id, instance_id, operated_at);
CREATE INDEX idx_flow_task_log_task ON flow_task_log (task_id);