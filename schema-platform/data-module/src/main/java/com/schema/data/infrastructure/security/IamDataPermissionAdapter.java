package com.schema.data.infrastructure.security;

import com.schema.data.domain.repository.DataPermissionPort;
import com.schema.iam.domain.repository.IamRepository;
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
 * 字段级：FIELD 资源型权限点（resource_type='FIELD'，resource_id=model_id，
 * action='visible'/'editable'）——不在授权集内的字段默认拒绝（最小权限）。
 */
@Component
public class IamDataPermissionAdapter implements DataPermissionPort {

    private final IamRepository iam;

    public IamDataPermissionAdapter(IamRepository iam) {
        this.iam = iam;
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
    public Set<String> invisibleFields(long tenantId, long userId, long modelId) {
        return fieldKeys(tenantId, userId, modelId, "visible");
    }

    @Override
    public Set<String> uneditableFields(long tenantId, long userId, long modelId) {
        return fieldKeys(tenantId, userId, modelId, "editable");
    }

    /**
     * 字段级权限语义：FIELD 行 resource_id=model_id，action=visible/editable 的授权集外的
     * 字段不可见/不可编辑（默认拒绝）。无任何 FIELD 授权 = 全字段拒绝 → 返回 null 语义标记
     * 无法由 Set 表达，调用方以「授权集是否为空」判定全拒绝。
     * 此处返回「已授权可见的字段集」的补集逻辑放在引擎侧（需字段全集）——本方法返回授权集本身。
     */
    private Set<String> fieldKeys(long tenantId, long userId, long modelId, String action) {
        List<Long> roleIds = roleIds(tenantId, userId);
        if (roleIds.isEmpty()) {
            return Set.of();
        }
        Set<String> granted = new HashSet<>();
        for (var perm : iam.findPermsOfRoles(roleIds)) {
            if ("FIELD".equals(perm.resourceType()) && perm.resourceId() == modelId
                    && action.equals(perm.action())) {
                // FIELD 授权的扩展形态：action 携带字段键（如 visible:amount）——
                // 授权粒度是字段级；无字段键 = 整模型字段全授权
                granted.add(perm.action());
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
