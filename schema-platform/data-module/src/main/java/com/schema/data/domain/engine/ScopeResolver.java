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
 *   DEPT_TREE  → data->>'dept_id' IN (SELECT id FROM sys_dept WHERE path LIKE :deptPath || '%')
 *   CUSTOM_EXPR→ 仅支持字段 vs 用户属性比较（白名单函数/无子查询——L1 表达式结构级拦截，
 *                MVP 落地为编译前语法闸门：拒绝含 SELECT/JOIN/;/-- 等危险词的表达式）
 *
 * 无任何范围授权 = 默认拒绝（1=0）——最小权限原则。
 */
public final class ScopeResolver {

    private ScopeResolver() {
    }

    /** 编译范围集为 SQL 条件段（调用方已确保非 ALL 短路）。 */
    public static String resolve(List<DataPermissionPort.ScopeCondition> scopes,
            long userId, long deptId, String deptPath, List<Object> params) {
        if (scopes.isEmpty()) {
            // 无授权范围：默认拒绝（不给任何行）
            return "1 = 0";
        }
        if (PermissionPolicy.seesAll(scopes.stream()
                .map(s -> new PermissionPolicy.DataScope(0, 0, s.scopeType(), s.scopeExpr()))
                .toList())) {
            return "TRUE";
        }
        List<String> parts = new ArrayList<>();
        for (DataPermissionPort.ScopeCondition scope : scopes) {
            switch (scope.scopeType()) {
                case "SELF" -> {
                    params.add(userId);
                    parts.add("created_by = ?");
                }
                case "DEPT" -> {
                    params.add(String.valueOf(deptId));
                    parts.add("(data->>'dept_id') = ?");
                }
                case "DEPT_TREE" -> {
                    params.add(deptPath == null ? "/" : deptPath);
                    parts.add("(data->>'dept_id') IN (SELECT CAST(id AS VARCHAR) FROM sys_dept "
                            + "WHERE path LIKE ? || '%')");
                }
                case "CUSTOM_EXPR" -> parts.add(compileCustomExpr(scope.scopeExpr(), userId, params));
                default -> {
                    // 未知范围类型：跳过（宁缺勿滥——不放大权限）
                }
            }
        }
        if (parts.isEmpty()) {
            return "1 = 0"; // 全部为未知类型 = 默认拒绝
        }
        return "(" + String.join(" OR ", parts) + ")";
    }

    /**
     * CUSTOM_EXPR 编译（03BE §3.3 白名单：字段 vs 当前用户属性比较）。
     * MVP 受限形态：仅支持 `fieldKey op ${currentUserId|currentUserDeptId}` 二元比较。
     */
    private static String compileCustomExpr(String expr, long userId, List<Object> params) {
        if (expr == null || expr.isBlank()) {
            return "1 = 0";
        }
        String lowered = expr.toLowerCase();
        if (lowered.contains("select") || lowered.contains("join") || lowered.contains(";")
                || lowered.contains("--") || lowered.contains("/*") || lowered.contains("union")) {
            return "1 = 0"; // 危险词直接拒绝（不放大权限）
        }
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("^(\\w+)\\s*(=|<>|!=|>=|<=|>|<)\\s*\\$\\{(currentUserId|currentUserDeptId)\\}$")
                .matcher(expr.trim());
        if (!m.matches()) {
            return "1 = 0"; // 结构不匹配 = 拒绝（白名单形态之外一律不放行）
        }
        String fieldKey = SqlBuilder.PhysicalIdent.column(m.group(1));
        String op = m.group(2).equals("!=") ? "<>" : m.group(2);
        params.add("currentUserId".equals(m.group(3)) ? userId : 0L);
        return "(data->>'" + fieldKey + "')" + " " + op + " CAST(? AS TEXT)";
    }
}
