package com.schema.data.domain.engine;

import com.schema.data.domain.repository.DataPermissionPort;
import com.schema.iam.domain.model.PermissionPolicy;

import java.util.ArrayList;
import java.util.List;

/**
 * 行级数据范围 SQL 生成（03BE §3.3）：多角色并集 OR 连接。
 *
 *   ALL        → TRUE（seesAll 短路，不加条件段）
 *   SELF       → created_by = :userId
 *   DEPT       → data->>'dept_id' = :userDeptId（记录冗余部门键写入时固化）
 *   DEPT_TREE  → data->>'dept_id' IN (SELECT ... FROM sys_dept WHERE tenant_id=? AND path LIKE :deptPath||'%')
 *   CUSTOM_EXPR→ 仅支持字段 vs 用户属性比较（白名单函数/无子查询——L1 表达式结构级拦截，
 *                MVP 落地为编译前语法闸门：拒绝含 SELECT/JOIN/;/-- 等危险词的表达式）
 *
 * 安全口径（修正 2026-10-30）：
 * - 用户无部门（deptId<=0）或部门无物化路径时，DEPT/DEPT_TREE/CUSTOM_EXPR(dept) 一律 1=0
 *   （默认拒绝——不退化放宽）；
 * - DEPT_TREE 子查询带 tenant_id 条件（跨租户部门不得放大可见范围）。
 * 无任何范围授权 = 默认拒绝（1=0）——最小权限原则。
 */
public final class ScopeResolver {

    private ScopeResolver() {
    }

    /** 编译范围集为 SQL 条件段（调用方已确保非 ALL 短路）。 */
    public static String resolve(List<DataPermissionPort.ScopeCondition> scopes,
            long userId, DataPermissionPort.UserAttrs attrs, long tenantId, List<Object> params) {
        if (scopes.isEmpty()) {
            // 无授权范围：默认拒绝（不给任何行）
            return "1 = 0";
        }
        if (PermissionPolicy.seesAll(scopes.stream()
                .map(s -> new PermissionPolicy.DataScope(0, 0, s.scopeType(), s.scopeExpr()))
                .toList())) {
            return "TRUE";
        }
        long deptId = attrs == null ? 0 : attrs.deptId();
        String deptPath = attrs == null ? null : attrs.deptPath();
        boolean deptKnown = deptId > 0;
        List<String> parts = new ArrayList<>();
        for (DataPermissionPort.ScopeCondition scope : scopes) {
            switch (scope.scopeType()) {
                case "SELF" -> {
                    params.add(userId);
                    parts.add("created_by = ?");
                }
                case "DEPT" -> {
                    if (deptKnown) {
                        params.add(String.valueOf(deptId));
                        parts.add("(data->>'dept_id') = ?");
                    }
                    // 无部门上下文：默认拒绝（不生成条件——空 parts 回落 1=0）
                }
                case "DEPT_TREE" -> {
                    if (deptKnown && deptPath != null && !deptPath.isBlank()) {
                        params.add(tenantId);
                        params.add(deptPath);
                        parts.add("(data->>'dept_id') IN (SELECT CAST(id AS VARCHAR) FROM sys_dept "
                                + "WHERE tenant_id = ? AND path LIKE ? || '%')");
                    }
                    // 无部门路径：默认拒绝（不再退化为 '/' 放大到全部部门）
                }
                case "CUSTOM_EXPR" -> {
                    String compiled = compileCustomExpr(scope.scopeExpr(), userId, deptId, params);
                    if (compiled != null) {
                        parts.add(compiled);
                    }
                }
                default -> {
                    // 未知范围类型：跳过（宁缺勿滥——不放大权限）
                }
            }
        }
        if (parts.isEmpty()) {
            return "1 = 0"; // 全部为未知类型/无部门上下文 = 默认拒绝
        }
        return "(" + String.join(" OR ", parts) + ")";
    }

    /**
     * CUSTOM_EXPR 编译（03BE §3.3 白名单：字段 vs 当前用户属性比较）。
     * MVP 受限形态：仅支持 `fieldKey op ${currentUserId|currentUserDeptId}` 二元比较。
     * 引用 currentUserDeptId 但用户无部门 → 整段拒绝（返回 null 不参与 OR 并集）。
     */
    private static String compileCustomExpr(String expr, long userId, long deptId, List<Object> params) {
        if (expr == null || expr.isBlank()) {
            return null;
        }
        String lowered = expr.toLowerCase();
        if (lowered.contains("select") || lowered.contains("join") || lowered.contains(";")
                || lowered.contains("--") || lowered.contains("/*") || lowered.contains("union")) {
            return null; // 危险词直接拒绝（不放大权限）
        }
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("^(\\w+)\\s*(=|<>|!=|>=|<=|>|<)\\s*\\$\\{(currentUserId|currentUserDeptId)\\}$")
                .matcher(expr.trim());
        if (!m.matches()) {
            return null; // 结构不匹配 = 拒绝（白名单形态之外一律不放行）
        }
        String fieldKey = SqlBuilder.PhysicalIdent.column(m.group(1));
        String op = m.group(2).equals("!=") ? "<>" : m.group(2);
        boolean isDeptAttr = "currentUserDeptId".equals(m.group(3));
        if (isDeptAttr && deptId <= 0) {
            return null; // 无部门上下文：默认拒绝
        }
        params.add(isDeptAttr ? String.valueOf(deptId) : userId);
        return "(data->>'" + fieldKey + "')" + " " + op + " CAST(? AS TEXT)";
    }
}
