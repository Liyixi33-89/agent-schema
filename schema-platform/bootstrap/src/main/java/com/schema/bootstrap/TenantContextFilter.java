package com.schema.bootstrap;

import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * 租户上下文还原（03BE §2.1：网关写 header X-Tenant-Id → 服务 Filter 还原 TenantContext）。
 * M2 阶段登录链路未落地：无头时退化默认租户（单租户可退化约束）；M3 后强制校验 JWT claim 一致。
 */
@Component
public class TenantContextFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain chain) throws ServletException, IOException {
        String tenantIdHeader = request.getHeader("X-Tenant-Id");
        String appIdHeader = request.getHeader("X-App-Id");
        String operatorIdHeader = request.getHeader("X-Operator-Id");
        try {
            TenantInfo tenant = new TenantInfo(
                    parseOr(tenantIdHeader, 1L),
                    parseOr(appIdHeader, 1L),
                    parseOr(operatorIdHeader, 1L));
            TenantContext.with(tenant, () -> {
                try {
                    chain.doFilter(request, response);
                } catch (IOException | ServletException e) {
                    throw new RuntimeException(e);
                }
                return null;
            });
        } finally {
            TenantContext.clear();
        }
    }

    private static long parseOr(String header, long fallback) {
        if (header == null || header.isBlank()) {
            return fallback;
        }
        try {
            long v = Long.parseLong(header.trim());
            return v > 0 ? v : fallback;
        } catch (NumberFormatException e) {
            return fallback;
        }
    }
}
