package com.schema.iam.domain.model;

import java.util.ArrayList;
import java.util.List;

/**
 * 权限判定纯函数（03BE §3.2/§3.3）：角色 → 权限点快照（perms 串）/ 行级数据范围并集。
 * 领域层只做集合运算；SQL 片段生成归 data-engine（M5.2 权限注入管线），本类输出 scope 类型集合。
 */
public final class PermissionPolicy {

    /** 权限点（resource_type, resource_id, action）三元组。 */
    public record Perm(String resourceType, long resourceId, String action) {

        /** perms 串形态（03BE §A.2）：page:view:{id} / action:{key}——auth-sdk O(1) 判断。 */
        public String toPermString() {
            if ("ACTION".equals(resourceType)) {
                return "action:" + action;
            }
            return resourceType.toLowerCase() + ":" + action + ":" + resourceId;
        }
    }

    /** 行级数据范围（03BE §3.3）。 */
    public record DataScope(long roleId, long modelId, String scopeType, String scopeExpr) {
    }

    private PermissionPolicy() {
    }

    /** 多角色权限点并集（重复幂等）。 */
    public static List<Perm> unionPerms(List<Perm> perms) {
        List<Perm> result = new ArrayList<>();
        for (Perm p : perms) {
            if (!result.contains(p)) {
                result.add(p);
            }
        }
        return result;
    }

    /**
     * 行级可见范围并集（03BE §3.3）：多角色取并集（最大可见范围）。
     * ALL 出现即全量可见；调用方据此短路 SQL 条件生成。
     */
    public static boolean seesAll(List<DataScope> scopes) {
        return scopes.stream().anyMatch(s -> "ALL".equals(s.scopeType()));
    }

    /** CUSTOM_EXPR 白名单闸门（03BE §3.3：禁止子查询/危险函数——结构级拦截在表达式引擎，此处按类型放行）。 */
    public static boolean isKnownScopeType(String scopeType) {
        return "ALL".equals(scopeType) || "SELF".equals(scopeType) || "DEPT".equals(scopeType)
                || "DEPT_TREE".equals(scopeType) || "CUSTOM_EXPR".equals(scopeType);
    }
}
