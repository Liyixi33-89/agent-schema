package com.schema.platform.common.tenant;

/**
 * 租户上下文（03BE §2.1 定版：存储实现接口化，ThreadLocal 默认实现，预览特性不进主干）。
 * 业务代码只经 TenantContext 访问；异步边界入口必须显式 with() 传递并 finally 清理。
 */
public final class TenantContext {

    private static final TenantContextHolder HOLDER = TenantContextHolder.threadLocal();

    private TenantContext() {
    }

    public static TenantInfo get() {
        return HOLDER.get();
    }

    public static <T> T with(TenantInfo tenant, java.util.function.Supplier<T> action) {
        return HOLDER.with(tenant, action);
    }

    public static void clear() {
        HOLDER.clear();
    }
}
