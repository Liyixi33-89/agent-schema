-- M5 三轮收口（2026-10-30）：Outbox 租约 fencing token
-- 旧缺口：投递方 A 抢占后租约过期被回收重投给 B，A 恢复后仍可写 DONE/FAILED 覆盖 B 的结果。
-- lease_token 随抢占 CAS 轮转，状态写入带 token 条件（fencing）——旧持有者写入 0 行自然失效。
ALTER TABLE outbox_event ADD COLUMN lease_token VARCHAR(64);
