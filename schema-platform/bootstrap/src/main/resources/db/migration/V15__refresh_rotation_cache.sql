-- V15：refresh 容忍窗口「同一次轮换结果」缓存列（2026-11-03 认证收口）。
-- 语义：首次消费成功时把本次签发的新 refresh 哈希与 csrf 写回消费行——
-- ±10s 窗口内的重放直接复用同一组轮换结果再签发，不再滚动新链（多标签各自成链收敛）。
-- 列可空：老数据/容忍窗口外行为不变；登出全量吊销不依赖此列。
ALTER TABLE sys_refresh_token ADD COLUMN IF NOT EXISTS rotated_hash varchar(64);
ALTER TABLE sys_refresh_token ADD COLUMN IF NOT EXISTS rotated_csrf varchar(64);
CREATE INDEX IF NOT EXISTS idx_sys_refresh_token_user_active
    ON sys_refresh_token (user_id) WHERE revoked = false;
