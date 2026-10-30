package com.schema.bootstrap;

import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * 租户上下文还原（03BE §2.1）。
 * M3 起（JwtAuthFilter 前置）：优先取 JWT claim（auth.* 属性——claim 为鉴权真源）；
 * 无 claim 的头值退化仅在公开端点（登录/刷新/登出/CSP）可达——业务端点已被 401 挡在前面。
 *
 * 预览态透传（04BE §A.7 数据面收口）：auth.preview/auth.previewPageId/
 * auth.previewAllowRealWrite 以请求属性传递——引擎侧 PreviewContext 静态读取
 * （TenantInfo 为值对象不承载预览态；拆分后随 RPC 上下文头传递）。
 */
@Component
@Order(2)
public class TenantContextFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain chain) throws ServletException, IOException {
        Long userId = attr(request, "auth.userId");
        Long tenantId = attr(request, "auth.tenantId");
        String tenantIdHeader = request.getHeader("X-Tenant-Id");
        String appIdHeader = request.getHeader("X-App-Id");
        String operatorIdHeader = request.getHeader("X-Operator-Id");
        Boolean preview = (Boolean) request.getAttribute("auth.preview");
        try {
            TenantInfo tenant = new TenantInfo(
                    tenantId != null ? tenantId : parseOr(tenantIdHeader, 1L),
                    parseOr(appIdHeader, 1L),
                    userId != null ? userId : parseOr(operatorIdHeader, 1L));
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

    private static Long attr(HttpServletRequest request, String name) {
        Object v = request.getAttribute(name);
        return v instanceof Long l ? l : null;
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
