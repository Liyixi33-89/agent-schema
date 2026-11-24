-- V20：sys_dept 补 (tenant_id, path) 唯一约束
--
-- 背景（spec 021 T8 实测暴露）：
-- V3 建 sys_dept 时只有 (id) 主键，(tenant_id, path) 无唯一性。
-- 后果：同一租户下可插入多个相同 path 的部门 —— 物化路径本应唯一标识一个部门，
-- 重复会让「按 path 查部门」「按 path 前缀查子树」返回多行，
-- 下游 queryForObject 直接 IncorrectResultSize（IT 已踩到，真实业务同样会踩）。
--
-- 迁移前已探测存量（本地 dev / 验收库均无重复；本地有 1 行 path IS NULL 的测试残留，
-- 唯一约束对 NULL 不生效，不会阻塞迁移，此处按需清理）。
--
-- 纪律：只增不改。用 UNIQUE INDEX 而非 ALTER TABLE ADD CONSTRAINT ——
-- 前者可用 IF NOT EXISTS 保证幂等，且不影响既有外键。

-- ① 清理 path 为 NULL 的孤儿部门（无 path 无法参与子树计算，且无用户挂靠时才清）
--    加 NOT EXISTS 保护：万一线上有用户挂在 NULL path 部门上，宁可不删（迁移仍能过，
--    UNIQUE 对 NULL 不生效），也不能静默删掉有人的部门。
DELETE FROM sys_dept d
WHERE d.path IS NULL
  AND NOT EXISTS (SELECT 1 FROM sys_user u WHERE u.dept_id = d.id);

-- ② 唯一索引（NULL 不参与唯一性判定，故历史 NULL 行不阻塞）
CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_dept_tenant_path
    ON sys_dept (tenant_id, path);

COMMENT ON INDEX uq_sys_dept_tenant_path IS
    '同租户下物化路径唯一（spec 021 T8 收口：防重复部门导致按 path 查询返回多行）';