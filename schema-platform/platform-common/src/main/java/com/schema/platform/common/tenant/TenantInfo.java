package com.schema.platform.common.tenant;

/**
 * 租户信息值对象。单租户模式恒返回默认租户（可退化约束，03BE §2.1）。
 */
public record TenantInfo(long tenantId, long appId, long operatorId) {

    /** 单租户退化默认值（M2 阶段无登录链路，业务表先按默认租户落地）。 */
    public static final TenantInfo DEFAULT = new TenantInfo(1L, 1L, 1L);

    public TenantInfo {
        if (tenantId <= 0) {
            throw new IllegalArgumentException("tenantId must be positive");
        }
    }
}
