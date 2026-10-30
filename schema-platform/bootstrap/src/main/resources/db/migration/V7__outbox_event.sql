-- M2/M5 尾项收口（2026-10-30）：Outbox 可靠事件表（02BE §2.1 建表联动可靠版）
-- 铁律：只增不改；业务事务内 enqueue（同事务原子性）→ OutboxRelay 轮询投递（至少一次）
CREATE TABLE outbox_event (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,
    topic         VARCHAR(64) NOT NULL,
    payload       JSONB NOT NULL,
    status        VARCHAR(16) NOT NULL DEFAULT 'PENDING',   -- PENDING/DELIVERING/DONE/FAILED
    attempts      INT NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at  TIMESTAMPTZ
);
CREATE INDEX idx_outbox_pending ON outbox_event(status, id) WHERE status = 'PENDING';
