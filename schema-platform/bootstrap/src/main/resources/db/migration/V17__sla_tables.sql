-- M16 SLA 可用性看板（PRD11 §2.1 统计口径 + 09BE §4 sla.availability）：
-- 分钟级可用性采样 + 计划内维护窗口登记（SLA 排除项数据源）。
-- 纪律：只增不改；SLA 采样可从明细重算（可用性 = (总分钟 - 不可用分钟)/总分钟）。

-- 分钟级可用性采样（09BE §4：P0/P1 请求成功率，统计日归集——内部看板不出账）
-- quantity 语义：该分钟核心接口总请求数；attrs 记 {ok, failed}——失败率>5% 或全不可达即不可用分钟
CREATE TABLE sla_minute_sample (
    tenant_id   BIGINT NOT NULL,
    minute      TIMESTAMPTZ NOT NULL,          -- 分钟粒度（date_trunc('minute')）
    total_req   BIGINT NOT NULL DEFAULT 0,     -- 该分钟核心接口总请求
    failed_req  BIGINT NOT NULL DEFAULT 0,     -- 该分钟失败请求
    unreachable BOOLEAN NOT NULL DEFAULT FALSE, -- 探测不可达（全不可达分钟）
    PRIMARY KEY (tenant_id, minute)
);
CREATE INDEX idx_sla_sample_minute ON sla_minute_sample(tenant_id, minute);

-- 计划内维护窗口（PRD11 §2.1 排除项：提前 72h 公告，每月≤1次、单次≤2h）
-- 窗口分钟数从当月总分钟中扣除再计算可用性（不是从不可用分钟中扣）
CREATE TABLE ops_maintenance_window (
    id           BIGSERIAL PRIMARY KEY,
    tenant_id    BIGINT NOT NULL,              -- 0 = 平台级（全租户生效）
    title        VARCHAR(128) NOT NULL,
    start_at     TIMESTAMPTZ NOT NULL,
    end_at       TIMESTAMPTZ NOT NULL,
    announced_at TIMESTAMPTZ,                  -- 公告时间（须早于 start_at 72h——校验在应用层）
    status       VARCHAR(16) NOT NULL DEFAULT 'PLANNED',  -- PLANNED / ACTIVE / DONE / CANCELLED
    operator_id  BIGINT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_at > start_at)
);
CREATE INDEX idx_maint_window_time ON ops_maintenance_window(tenant_id, start_at);
