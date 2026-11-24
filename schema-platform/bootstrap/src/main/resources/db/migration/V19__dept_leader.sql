-- spec 021 T6 补强：部门负责人字段
--
-- 背景：审批人模式 INITIATOR_SUPERVISOR 的语义是「发起人的直属上级」。
-- V3 建 sys_dept 时只有 (parent_id, path)，**没有负责人概念**，
-- 导致该模式只能退化为「上一级部门全体成员」——多人时全部成为候选人，
-- 与「直属上级单人审批」的业务预期不符。
--
-- 本迁移补一列，把语义补成：发起人所在部门的 leader_id → 单人审批。
--
-- 纪律：只增不改（新增可空列，对既有行零影响；既有部门 leader 为 NULL 时
-- 解析仍回落 fallbackUserIds，再空则 BLOCK——不改变现状行为）。
ALTER TABLE sys_dept
    ADD COLUMN leader_id BIGINT;

COMMENT ON COLUMN sys_dept.leader_id IS
    '部门负责人（直属上级审批的解析目标，spec 021 T6）；为空时按 fallbackUserIds 兜底';

-- 解析查询按 (tenant_id, leader_id) 走，补索引避免全表扫
CREATE INDEX idx_sys_dept_leader ON sys_dept (tenant_id, leader_id)
    WHERE leader_id IS NOT NULL;