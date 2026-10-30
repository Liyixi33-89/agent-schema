package com.schema.data.domain.repository;

import java.util.List;

/**
 * 行级/字段级数据权限端口（03BE §3.3/§3.4）：权限定义归 iam，data-engine 只消费。
 *
 * 行级：resolveScopes 返回该用户在该模型上的数据范围并集（多角色 OR 连接）；
 * 用户属性上下文（部门/角色）由 resolveUserAttrs 提供——DEPT/DEPT_TREE/CUSTOM_EXPR 编译消费。
 *
 * 字段级（语义定版，修正 2026-10-30）：sys_role_permission 行 resource_type='FIELD'，
 * resource_id=model_id，action='visible'/'editable' 时，字段键编码在 scope 列——
 * 真源表无独立字段键存储位，故授权行形态为 scope='visible:<fieldKey>'。
 * 返回「已授权字段键集」（而非不可见集）：空集语义二义（未配置 vs 全拒绝）由调用方以
 * hasFieldPermConfig 判定——未配置 = 全可见；已配置 = 仅授权集可见（最小权限）。
 */
public interface DataPermissionPort {

    record ScopeCondition(String scopeType, String scopeExpr) {
    }

    /** 当前用户属性（03BE §3.3 表达式上下文注入源）。 */
    record UserAttrs(long deptId, String deptPath) {
    }

    /** 用户在模型上的行级范围集（空集 = 无任何数据范围授权——默认拒绝）。 */
    List<ScopeCondition> resolveScopes(long tenantId, long userId, long modelId);

    /** 用户属性（部门 ID/物化路径）——无部门时 deptId=0/deptPath=null（范围编译按拒绝处理）。 */
    UserAttrs resolveUserAttrs(long tenantId, long userId);

    /**
     * 模型级字段权限配置存在性判定（03BE §3.4 默认拒绝口径，2026-10-30 三轮收口）：
     * 与用户无关——只看模型上是否存在任意 FIELD 权限行。
     * 已配置模型：无授权用户（无角色/角色无 FIELD 行）一律默认拒绝（授权集为空集）；
     * 未配置模型：全字段默认可见/可编辑（不锁死未配置模型）。
     * ⚠️ 不允许退回按用户判定——「用户恰好没角色」会把已配置模型放大成全字段可见。
     */
    boolean hasFieldPermConfig(long tenantId, long modelId);

    /** 已授权「可见」字段键集（仅在 hasFieldPermConfig=true 时有意义）。 */
    java.util.Set<String> visibleFields(long tenantId, long userId, long modelId);

    /** 已授权「可编辑」字段键集（仅在 hasFieldPermConfig=true 时有意义）。 */
    java.util.Set<String> editableFields(long tenantId, long userId, long modelId);
}
