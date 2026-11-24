package com.schema.flow.infrastructure.flowable;

import com.schema.flow.domain.ApproverResolver;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.List;

/**
 * 机构数据只读实现（供 {@link ApproverResolver} 使用）。
 *
 * 只查三张 IAM 表，语义窄、无写操作：
 * - sys_user.dept_id      用户主部门
 * - sys_dept.parent_id    部门上级（无「部门负责人」字段——见下方说明）
 * - sys_user_role+sys_role 部门内按角色筛选成员
 *
 * ⚠️ 已知能力边界：本系统 sys_dept 只有 (parent_id, path)，
 * **没有 leader/manager 字段**。因此「直属上级」落在「上一级部门成员」，
 * 解析不到时由流程配置的 fallbackUserIds 兜底，再不行则 BLOCK 挂起。
 * 不臆造不存在的字段——假装解析成功会让流程静默走进死路。
 */
public class JdbcOrgQueryPort implements ApproverResolver.OrgQueryPort {

    private final JdbcTemplate jdbc;

    public JdbcOrgQueryPort(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public List<Long> findUsersInDeptWithRoles(long tenantId, long deptId, List<String> roleKeys) {
        if (roleKeys == null || roleKeys.isEmpty()) {
            return List.of();
        }
        // 动态占位符：roleKeys 长度可变（不用字符串拼接，避免注入面）
        String placeholders = String.join(",", java.util.Collections.nCopies(roleKeys.size(), "?"));
        String sql = """
                SELECT DISTINCT u.id
                FROM sys_user u
                JOIN sys_user_role ur ON ur.user_id = u.id
                JOIN sys_role r ON r.id = ur.role_id
                WHERE u.tenant_id = ? AND u.dept_id = ? AND u.status = 'ACTIVE'
                  AND r.code IN (%s)
                ORDER BY u.id
                """.formatted(placeholders);

        List<Object> args = new ArrayList<>();
        args.add(tenantId);
        args.add(deptId);
        args.addAll(roleKeys);
        return jdbc.queryForList(sql, Long.class, args.toArray());
    }

    @Override
    public Long findPrimaryDeptId(long tenantId, long userId) {
        List<Long> rows = jdbc.queryForList(
                "SELECT dept_id FROM sys_user WHERE tenant_id = ? AND id = ?",
                Long.class, tenantId, userId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    @Override
    public Long findParentDeptId(long tenantId, long deptId) {
        List<Long> rows = jdbc.queryForList(
                "SELECT parent_id FROM sys_dept WHERE tenant_id = ? AND id = ?",
                Long.class, tenantId, deptId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    @Override
    public List<Long> findUsersInDept(long tenantId, long deptId) {
        return jdbc.queryForList("""
                SELECT id FROM sys_user
                WHERE tenant_id = ? AND dept_id = ? AND status = 'ACTIVE'
                ORDER BY id
                """, Long.class, tenantId, deptId);
    }
}