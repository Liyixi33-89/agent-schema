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
import java.net.URI;
import java.util.List;

/**
 * CSRF 双提交 + Origin 校验过滤器（v0.4 四道防线第一/二道，03BE §4 收口版）：
 * 1) 双提交：携带正式会话凭证（schema_at cookie）的状态变更请求（非 GET/HEAD）
 *    必须带 X-CSRF-Token 头且与 schema_csrf cookie 等值；缺失/不等 403 CSRF_TOKEN_REJECTED；
 * 2) Origin/Referer：同上请求必须来源匹配（精确 host:port 比对）；缺失或不匹配 403 CSRF_ORIGIN_REJECTED。
 *
 * 边界语义（收口修正）：
 * - 匿名请求（无 schema_at 凭证）放行——认证边界语义优先，无凭证 401 而非 403；
 *   登录请求经 GET /api/auth/csrf 预签后带双提交（有 csrf cookie 即要求等值头）；
 * - Bearer 豁免限定：仅合法「Bearer 」前缀头跳过（预览/嵌入通道无 cookie 自动携带语义，
 *   04BE §A.7）；任意 Authorization 头不再一刀切豁免（防伪造头绕过）；
 * - Origin 精确匹配：scheme://host:port 全等（contains 子串匹配可被 evil-host:port 绕过）；
 *   无凭证浏览器场景不会缺 Origin/Referer（跨站表单/_fetch 都带），缺失即拒；
 * - 本地文件预签名端点（一次性 token 鉴权）豁免。
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
        // Bearer 豁免限定：合法「Bearer 」前缀头（预览/嵌入与存量集成通道——无 cookie 自动携带语义）；
        // 其他 Authorization 形态（伪造头）不豁免，回落双提交判定
        String authHeader = request.getHeader("Authorization");
        if (authHeader != null && authHeader.startsWith("Bearer ")) {
            chain.doFilter(request, response);
            return;
        }
        String csrfCookie = SessionCookies.read(request, SessionCookies.CSRF);
        boolean hasSession = SessionCookies.read(request, SessionCookies.AT) != null;
        // 匿名请求（无会话凭证且无 csrf cookie）：放行给 JwtAuthFilter 判 401（认证边界语义优先）
        if (!hasSession && (csrfCookie == null || csrfCookie.isBlank())) {
            chain.doFilter(request, response);
            return;
        }

        // 第一道：双提交（会话请求必须有等值头；预签过 csrf 的登录请求同样受双提交保护）
        String header = request.getHeader("X-CSRF-Token");
        if (csrfCookie == null || csrfCookie.isBlank()
                || header == null || header.isBlank() || !header.equals(csrfCookie)) {
            writeError(response, "CSRF_TOKEN_REJECTED", "请求缺少有效的防伪令牌，请刷新页面重试");
            return;
        }

        // 第二道：Origin/Referer（浏览器请求至少其一存在且精确匹配）
        if (!isSameOrigin(request)) {
            writeError(response, "CSRF_ORIGIN_REJECTED", "请求来源校验失败");
            return;
        }
        chain.doFilter(request, response);
    }

    /** Origin/Referer 精确匹配（scheme://host:port 全等；缺失即拒——非浏览器客户端走 Bearer）。 */
    private boolean isSameOrigin(HttpServletRequest request) {
        String target = originOf(request);
        String origin = request.getHeader("Origin");
        if (origin != null && !origin.isBlank()) {
            return origin.equals(target) || DEV_ORIGINS.contains(origin);
        }
        String referer = request.getHeader("Referer");
        if (referer != null && !referer.isBlank()) {
            URI uri = URI.create(referer);
            String refererOrigin = uri.getScheme() + "://" + uri.getRawAuthority();
            return refererOrigin.equals(target) || DEV_ORIGINS.contains(refererOrigin);
        }
        // 同源浏览器请求不会两者皆缺失——缺失视为非预期客户端，拒绝（测试走 Bearer 或显式头）
        return false;
    }

    /** 请求自身的规范 Origin（scheme://host:port；80/443 省略端口）。 */
    private static String originOf(HttpServletRequest request) {
        String scheme = request.getScheme();
        int port = request.getServerPort();
        boolean defaultPort = ("http".equals(scheme) && port == 80)
                || ("https".equals(scheme) && port == 443);
        return scheme + "://" + request.getServerName() + (defaultPort ? "" : ":" + port);
    }

    private static void writeError(HttpServletResponse response, String code, String message)
            throws IOException {
        response.setStatus(HttpServletResponse.SC_FORBIDDEN);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.getWriter().write("{\"code\":\"" + code + "\",\"message\":\"" + message + "\"}");
    }
}
