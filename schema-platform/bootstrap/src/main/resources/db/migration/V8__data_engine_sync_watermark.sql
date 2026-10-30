-- M5 二轮收口（2026-10-30）：schema 版本水位列——引擎按版本幂等收敛唯一索引；
-- DELIVERING 租约恢复支持（OutboxRelay 崩滞回收——超时 DELIVERING 回置 PENDING）
ALTER TABLE data_physical_table ADD COLUMN synced_version INT NOT NULL DEFAULT 0;

-- Outbox 投递租约（02BE §2.1 可靠链路）：DELIVERING 超过 60s 视为投递方崩溃滞留，
-- 轮询回收置回 PENDING（至少一次语义下的恢复闭环）
ALTER TABLE outbox_event ADD COLUMN lease_until TIMESTAMPTZ;
CREATE INDEX idx_outbox_stale ON outbox_event(status, lease_until)
    WHERE status = 'DELIVERING';
