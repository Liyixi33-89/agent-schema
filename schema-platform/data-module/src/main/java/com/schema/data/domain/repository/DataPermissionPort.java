package com.schema.data.domain.repository;

import java.util.List;

/**
 * 行级/字段级数据权限端口（03BE §3.3/§3.4）：权限定义归 iam，data-engine 只消费。
 * resolveScopes 返回该用户在该模型上的数据范围并集（多角色 OR 连接）；
 * 字段级权限返回不可见/不可编辑字段键集。
 */
public interface DataPermissionPort {

    record ScopeCondition(String scopeType, String scopeExpr) {
    }

    /** 用户在模型上的行级范围集（空集 = 无任何数据范围授权——默认拒绝）。 */
    List<ScopeCondition> resolveScopes(long tenantId, long userId, long modelId);

    /** 不可见字段键集（SELECT 与响应物理剔除，03BE §3.4——置 null 仍暴露存在性故必须剔除）。 */
    java.util.Set<String> invisibleFields(long tenantId, long userId, long modelId);

    /** 不可编辑字段键集（写入静默忽略 + debug 日志）。 */
    java.util.Set<String> uneditableFields(long tenantId, long userId, long modelId);
}
