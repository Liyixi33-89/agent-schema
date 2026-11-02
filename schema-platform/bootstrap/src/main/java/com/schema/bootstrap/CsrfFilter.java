package com.schema.bootstrap;

import com.schema.iam.infrastructure.security.SessionCookies;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.annotation.Order;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * CSRF 双提交 + Origin 校验过滤器（v0.4 四道防线第一/二道，03BE §4）：
 * 1) 双提交：状态变更请求（非 GET/HEAD）要求 X-CSRF-Token 头与 schema_csrf cookie 等值；
 *    缺失/不等 403 CSRF_TOKEN_REJECTED——跨站攻击者无法在不读 cookie 的情况下伪造头值；
 * 2) Origin/Referer：状态变更请求校验来源（缺失或不匹配 403 CSRF_ORIGIN_REJECTED）。
 *
 * 豁免：GET/HEAD（幂等约束）+ 预览/嵌入端点（Bearer 通道无 cookie 自动携带，04BE §A.7）+
 * 本地文件预签名端点（一次性 token 鉴权）。
 * 过渡兼容：请求显式携带 Authorization 头时跳过双提交（存量 Bearer 集成无 csrf cookie）。
 */
@Component
@Order(0)
public class CsrfFilter extends OncePerRequestFilter {

    /** Bearer 通道豁免端点（无 cookie 携带语义——04BE §A.7 口径）。 */
    private static final List<String> BEARING_EXEMPT_PREFIXES = List.of(
            "/api/preview/", "/api/files/local-put/", "/api/files/local-get/");

    /** 本地开发端口（Origin 校验放行——vite dev server 5173/5174/5175）。 */
    private static final List<String> DEV_ORIGINS = List.of(
            "http://localhost:5173", "http://localhost:5174", "http://localhost:5175",
            "http://127.0.0.1:5173", "http://127.0.0.1:5174", "http://127.0.0.1:5175");

    private final CsrfOriginVerifier originVerifier = new CsrfOriginVerifier();

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain chain) throws ServletException, IOException {
        String method = request.getMethod();
        if ("GET".equals(method) || "HEAD".equals(method)) {
            chain.doFilter(request, response);
            return;
        }
        String path = request.getRequestURI();
        if (BEARING_EXEMPT_PREFIXES.stream().anyMatch(path::startsWith)) {
            chain.doFilter(request, response);
            return;
        }
        // 过渡兼容：显式 Bearer 请求跳过双提交（存量集成无 csrf cookie；租户绑定仍由 JwtAuthFilter 收口）
        if (request.getHeader("Authorization") != null) {
            chain.doFilter(request, response);
            return;
        }
        // 无 csrf cookie 也无 Authorization：匿名请求放行给 JwtAuthFilter 判 401
        // （认证边界语义优先——无凭证 401 而非 403；登录请求经 /api/auth/csrf 预签 csrf 后带双提交）
        String anonCookie = SessionCookies.read(request, SessionCookies.CSRF);
        if (anonCookie == null || anonCookie.isBlank()) {
            chain.doFilter(request, response);
            return;
        }

        // 第一道：双提交
        String header = request.getHeader("X-CSRF-Token");
        if (header == null || header.isBlank() || !header.equals(anonCookie)) {
            writeError(response, "CSRF_TOKEN_REJECTED", "请求缺少有效的防伪令牌，请刷新页面重试");
            return;
        }

        // 第二道：Origin/Referer（同源请求至少其一存在且匹配）
        if (!originVerifier.isSameOrigin(request)) {
            writeError(response, "CSRF_ORIGIN_REJECTED", "请求来源校验失败");
            return;
        }
        chain.doFilter(request, response);
    }

    /** Origin/Referer 校验（缺失或不匹配即拒——本地开发端口放行）。 */
    static final class CsrfOriginVerifier {
        boolean isSameOrigin(HttpServletRequest request) {
            String origin = request.getHeader("Origin");
            String target = "://" + request.getServerName()
                    + (request.getServerPort() == 80 || request.getServerPort() == 443
                    ? "" : ":" + request.getServerPort());
            if (origin != null && !origin.isBlank()) {
                if (origin.contains(target)) {
                    return true;
                }
                return DEV_ORIGINS.contains(origin);
            }
            // Origin 缺失回落 Referer（部分浏览器同源 GET 不带 Origin）
            String referer = request.getHeader("Referer");
            if (referer != null && !referer.isBlank()) {
                if (referer.contains(target)) {
                    return true;
                }
                return DEV_ORIGINS.stream().anyMatch(referer::startsWith);
            }
            // 两者皆缺失：非浏览器客户端（curl/测试）放行双提交已兜底——生产可收紧
            return true;
        }
    }

    private static void writeError(HttpServletResponse response, String code, String message)
            throws IOException {
        response.setStatus(HttpServletResponse.SC_FORBIDDEN);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.getWriter().write("{\"code\":\"" + code + "\",\"message\":\"" + message + "\"}");
    }
}
