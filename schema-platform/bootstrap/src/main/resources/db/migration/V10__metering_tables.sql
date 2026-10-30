-- M8 计量埋点采集（09BE §3-5）：事件明细 + 日聚合 + 席位判定
-- 纪律：只增不改；明细与汇总分离（计费只读 usage_daily，汇总可从明细重算）
-- 注：分区表主键须含分区键；本地开发环境 PG 分区月滚动由归档任务后续接入（P1 手动补）

CREATE TABLE usage_event (
    event_id    VARCHAR(64) PRIMARY KEY,          -- 幂等键（客户端 UUID，重试复用）
    tenant_id   BIGINT NOT NULL,
    user_id     BIGINT,
    metric      VARCHAR(64) NOT NULL,             -- seat.active / flow.exec / ai.tokens.in / api.calls / storage.gb / build.count
    quantity    BIGINT NOT NULL DEFAULT 1,
    app_id      BIGINT,
    source      VARCHAR(16) NOT NULL DEFAULT 'CLIENT',  -- CLIENT(前端漏斗) / SERVER(服务端终审)
    occurred_at TIMESTAMPTZ NOT NULL,             -- 客户端事件时间（跨天归属用，限回溯 24h）
    received_at TIMESTAMPTZ NOT NULL,
    attrs       JSONB
);
CREATE INDEX idx_ue_agg ON usage_event(tenant_id, metric, occurred_at);

-- 日聚合（覆盖写幂等：聚合任务全量重算）
CREATE TABLE usage_daily (
    tenant_id BIGINT NOT NULL,
    metric    VARCHAR(64) NOT NULL,
    stat_date DATE NOT NULL,
    quantity  BIGINT NOT NULL,
    dims      JSONB,
    PRIMARY KEY (tenant_id, metric, stat_date)
);

-- 授权席位每日快照（13BE §2.4：授权口径判定归 tenant-service，每日一次不出计量事件）
CREATE TABLE seat_license_daily (
    tenant_id      BIGINT NOT NULL,
    stat_date      DATE NOT NULL,
    licensed_seats BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, stat_date)
);
