package com.schema.bootstrap;

import com.schema.iam.domain.model.UserAccount;
import com.schema.iam.domain.repository.IamRepository;
import com.schema.iam.infrastructure.security.JwtCodec;
import com.schema.platform.common.web.BizException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Lazy;
import org.springframework.core.annotation.Order;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Set;

/**
 * JWT 认证过滤器（03BE §3.2/§4）：
 * 1) Authorization: Bearer 验签（access token）；
 * 2) JWT claim 与 X-Tenant-Id 绑定——不一致 403 TENANT_MISMATCH 记安全审计（防伪造租户头）；
 * 3) must_change_password=true 时除放行名单外全部 403 PASSWORD_CHANGE_REQUIRED（§A.3.1）。
 *
 * 放行集：登录/刷新/登出（无登录态端点）+ CSP 上报。其余端点无 token 也放行但
 * operatorId 退化为头值（M2 兼容期；前端接入 auth-sdk 后收紧为强制 401——M6 前端联调开关）。
 */
@Component
@Order(1)
public class JwtAuthFilter extends OncePerRequestFilter {

    /** 登录态无关端点（公开）。 */
    private static final Set<String> PUBLIC_PATHS = Set.of(
            "/api/auth/login", "/api/auth/refresh", "/api/auth/logout", "/api/security/csp-reports");

    /** 强制改密放行名单（§A.3.1）：改密本体 + 登出 + me。 */
    private static final Set<String> PASSWORD_CHANGE_ALLOWLIST = Set.of(
            "/api/me/password", "/api/auth/logout", "/api/me");

    private final JwtCodec jwt;
    private final IamRepository iam;

    public JwtAuthFilter(JwtCodec jwt, @Lazy IamRepository iam) {
        this.jwt = jwt;
        this.iam = iam;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain chain) throws ServletException, IOException {
        String path = request.getRequestURI();
        String authHeader = request.getHeader("Authorization");

        if (authHeader == null || !authHeader.startsWith("Bearer ")) {
            // 未携带 token：公开端点直接过；其余放行但上下文由 TenantContextFilter 退化兜底（兼容期）
            chain.doFilter(request, response);
            return;
        }

        String token = authHeader.substring(7);
        JwtCodec.Claims claims = jwt.verify(token);
        if (claims == null || !"access".equals(claims.tokenType())) {
            writeError(response, HttpServletResponse.SC_UNAUTHORIZED, "UNAUTHORIZED", "登录态无效或已过期");
            return;
        }

        // 会话绑定（03BE §4）：鉴权以 claim 为准；头与 claim 不一致 403 + 安全审计
        String tenantHeader = request.getHeader("X-Tenant-Id");
        if (tenantHeader != null && !tenantHeader.isBlank()) {
            try {
                long headerTenant = Long.parseLong(tenantHeader.trim());
                if (headerTenant != claims.tenantId()) {
                    auditTenantMismatch(claims, headerTenant, request);
                    writeError(response, HttpServletResponse.SC_FORBIDDEN, "TENANT_MISMATCH",
                            "请求租户与登录租户不一致");
                    return;
                }
            } catch (NumberFormatException ignored) {
                // 非数字头交给 TenantContextFilter 退化处理
            }
        }

        // 强制改密拦截（§A.3.1）
        UserAccount user = iam.findUserById(claims.userId()).orElse(null);
        if (user != null && user.mustChangePassword() && !PASSWORD_CHANGE_ALLOWLIST.contains(path)
                && !PUBLIC_PATHS.contains(path)) {
            writeError(response, HttpServletResponse.SC_FORBIDDEN, "PASSWORD_CHANGE_REQUIRED",
                    "首次登录需修改密码");
            return;
        }

        // 认证信息透传：下游过滤器/控制器用头还原上下文（claim 为真源）
        request.setAttribute("auth.userId", claims.userId());
        request.setAttribute("auth.tenantId", claims.tenantId());
        chain.doFilter(request, response);
    }

    private void auditTenantMismatch(JwtCodec.Claims claims, long headerTenant, HttpServletRequest request) {
        try {
            iam.insertAudit("SECURITY", claims.tenantId(), claims.userId(), "USER",
                    String.valueOf(claims.userId()),
                    java.util.Map.of("reason", "TENANT_MISMATCH", "headerTenant", headerTenant),
                    request.getRemoteAddr(), request.getHeader("User-Agent"));
        } catch (Exception e) {
            // 审计失败不阻断拒绝路径
        }
    }

    private static void writeError(HttpServletResponse response, int status, String code, String message)
            throws IOException {
        response.setStatus(status);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.getWriter().write("{\"code\":\"" + code + "\",\"message\":\"" + message + "\"}");
    }
}
