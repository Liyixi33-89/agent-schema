package com.schema.data.infrastructure.security;

import com.schema.data.domain.repository.DataPermissionPort;
import com.schema.iam.domain.repository.IamRepository;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 数据权限端口适配器：消费 IAM 仓储的 sys_role_data_scope / FIELD 级权限点（03BE §3.3/§3.4）。
 *
 * 行级：多角色范围并集（PermissionPolicy.seesAll 由上层短路）；
 * 用户属性：sys_user.dept_id JOIN sys_dept 物化路径——DEPT/DEPT_TREE/CUSTOM_EXPR 的
 * 真实编译上下文（不再传占位 0/null）。
 *
 * 字段级：FIELD 行 resource_type='FIELD'，resource_id=model_id，
 * action='visible'/'editable'（整模型级）或 'visible:<fieldKey>'/'editable:<fieldKey>'
 * （字段级——真源表 sys_role_permission 无独立字段键列，键编码在 action 冒号后）。
 * 返回「已授权字段键集」；空集二义性由 hasFieldPermConfig 消解：
 * 未配置任何 FIELD 行 = 全字段默认可见/可编辑（不锁死未配置模型——MVP 定版口径）。
 */
@Component
public class IamDataPermissionAdapter implements DataPermissionPort {

    private final IamRepository iam;
    private final JdbcTemplate jdbc;

    public IamDataPermissionAdapter(IamRepository iam, JdbcTemplate jdbc) {
        this.iam = iam;
        this.jdbc = jdbc;
    }

    @Override
    public List<ScopeCondition> resolveScopes(long tenantId, long userId, long modelId) {
        List<Long> roleIds = roleIds(tenantId, userId);
        if (roleIds.isEmpty()) {
            return List.of();
        }
        List<ScopeCondition> result = new ArrayList<>();
        for (var scope : iam.findDataScopesOfRoles(roleIds)) {
            // model_id=0 为全模型通配（种子管理员兜底）；精确匹配优先于通配
            if (scope.modelId() == modelId || scope.modelId() == 0) {
                result.add(new ScopeCondition(scope.scopeType(), scope.scopeExpr()));
            }
        }
        return result;
    }

    @Override
    public UserAttrs resolveUserAttrs(long tenantId, long userId) {
        // 真实部门上下文：无部门 / 部门无 path → deptId=0/deptPath=null（范围编译按拒绝处理）
        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT u.dept_id, d.path FROM sys_user u
                  LEFT JOIN sys_dept d ON d.id = u.dept_id AND d.tenant_id = u.tenant_id
                 WHERE u.id = ?
                """, userId);
        if (rows.isEmpty() || rows.get(0).get("dept_id") == null) {
            return new UserAttrs(0, null);
        }
        long deptId = ((Number) rows.get(0).get("dept_id")).longValue();
        String path = (String) rows.get(0).get("path");
        return new UserAttrs(deptId, path == null || path.isBlank() ? null : path);
    }

    @Override
    public boolean hasFieldPermConfig(long tenantId, long modelId) {
        // 模型级判定（2026-10-30 三轮收口）：与用户无关——模型上存在任意 FIELD 权限行即已配置。
        // 此前按用户角色判定，模型已配置但用户无角色时误判「未配置」→ 全字段可见（越权）。
        return iam.hasFieldPermRows(tenantId, modelId);
    }

    @Override
    public Set<String> visibleFields(long tenantId, long userId, long modelId) {
        return grantedFieldKeys(tenantId, userId, modelId, "visible");
    }

    @Override
    public Set<String> editableFields(long tenantId, long userId, long modelId) {
        return grantedFieldKeys(tenantId, userId, modelId, "editable");
    }

    /**
     * 解析授权字段键集：
     * - action 精确等于前缀（'visible'/'editable'）→ 整模型字段全授权（标记 "*"）；
     * - action 形如 'visible:<fieldKey>' → 授权单个字段键。
     */
    private Set<String> grantedFieldKeys(long tenantId, long userId, long modelId, String prefix) {
        List<Long> roleIds = roleIds(tenantId, userId);
        if (roleIds.isEmpty()) {
            return Set.of();
        }
        Set<String> granted = new HashSet<>();
        for (var perm : iam.findPermsOfRoles(roleIds)) {
            if (!"FIELD".equals(perm.resourceType()) || perm.resourceId() != modelId) {
                continue;
            }
            String action = perm.action();
            if (prefix.equals(action)) {
                granted.add("*"); // 整模型字段全授权
            } else if (action != null && action.startsWith(prefix + ":")) {
                granted.add(action.substring(prefix.length() + 1));
            }
        }
        return granted;
    }

    private List<Long> roleIds(long tenantId, long userId) {
        List<Long> result = new ArrayList<>();
        for (Map<String, Object> r : iam.findRolesOfUser(tenantId, userId)) {
            if (r.get("id") instanceof Number n) {
                result.add(n.longValue());
            }
        }
        return result;
    }
}
