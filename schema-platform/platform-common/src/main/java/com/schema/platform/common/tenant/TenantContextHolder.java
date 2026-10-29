package com.schema.platform.common.tenant;

import java.util.function.Supplier;

/**
 * 租户上下文存储接口（03BE §2.1）：get / with / clear 三方法。
 * M0 默认 ThreadLocal 实现；JDK ScopedValue 转正式后无缝切换，业务代码零改动。
 */
public interface TenantContextHolder {

    TenantInfo get();

    <T> T with(TenantInfo tenant, Supplier<T> action);

    void clear();

    static TenantContextHolder threadLocal() {
        return new TenantContextHolder() {
            private final ThreadLocal<TenantInfo> local = new ThreadLocal<>();

            @Override
            public TenantInfo get() {
                TenantInfo t = local.get();
                return t != null ? t : TenantInfo.DEFAULT;
            }

            @Override
            public <T> T with(TenantInfo tenant, Supplier<T> action) {
                TenantInfo previous = local.get();
                local.set(tenant);
                try {
                    return action.get();
                } finally {
                    if (previous != null) {
                        local.set(previous);
                    } else {
                        local.remove();
                    }
                }
            }

            @Override
            public void clear() {
                local.remove();
            }
        };
    }
}
