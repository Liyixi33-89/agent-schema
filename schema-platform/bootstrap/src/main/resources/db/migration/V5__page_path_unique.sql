-- M4 收口：路由 path 单一真源 + 并发唯一约束
-- 问题：path 双真源（page_schema.path 与 draft.path 内嵌）不同步；普通索引不防并发重复
-- 修复：ACTIVE 态租户内部分唯一索引（DELETED 释放路径复用）；保存链路同步 page_schema.path

DROP INDEX IF EXISTS idx_page_path;
-- 仅 ACTIVE 态参与唯一性（逻辑删除的页面不占路径）；防并发 create/save 双写撞路径
CREATE UNIQUE INDEX uq_page_path_active ON page_schema(tenant_id, path) WHERE status='ACTIVE';
