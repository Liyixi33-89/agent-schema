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
 * 1) 双提交：携带正式会话凭证（schema_at / schema_rt 任一 cookie）的状态变更请求（非 GET/HEAD）
 *    必须带 X-CSRF-Token 头且与 schema_csrf cookie 等值；缺失/不等 403 CSRF_TOKEN_REJECTED；
 * 2) Origin/Referer：同上请求必须来源匹配（精确 host:port 比对）；缺失或不匹配 403 CSRF_ORIGIN_REJECTED。
 *
 * 边界语义（第二轮收口）：
 * - 会话凭证判定 = schema_at OR schema_rt（access 过期后 refresh 仍在时不得落入匿名放行分支——
 *   双提交须独立于 access 可独立执行，03BE §4.1 ④）；
 * - Cookie+Bearer 混合请求不豁免：Authorization「Bearer 」前缀豁免仅在【无任何会话 cookie】时生效
 *   （防「带受害 cookie + 伪造 Bearer 头」跨站请求绕过双提交——前缀检查不等于合法凭证校验）；
 * - 匿名请求（无任何会话凭证与 csrf cookie）放行给 JwtAuthFilter 判 401；
 * - 登录保护强制前置：/api/auth/login 无 csrf cookie 时不再匿名放行——先过 Origin 校验
 *   （跨站登录 CSRF 拦截），通过后放行由业务层登录失败计数兜底（前端登录页已先调 GET /api/auth/csrf，
 *   有 cookie 的登录仍走完整双提交）；
 * - Origin 精确匹配：scheme://host:port 全等（contains 子串匹配可被 evil-host:port 绕过）；
 *   Referer 解析失败（非法 URI）按不匹配拒绝，不抛 500；
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

    /** 登录端点（无 csrf cookie 时仍强制 Origin 校验——登录 CSRF 防护服务端边界）。 */
    private static final String LOGIN_PATH = "/api/auth/login";

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
        String csrfCookie = SessionCookies.read(request, SessionCookies.CSRF);
        boolean hasCsrf = csrfCookie != null && !csrfCookie.isBlank();
        // 会话凭证判定 = AT OR RT（access 过期 refresh 仍在时双提交须仍可独立执行——03BE §4.1 ④）
        boolean hasSession = SessionCookies.read(request, SessionCookies.AT) != null
                || SessionCookies.read(request, SessionCookies.RT) != null;
        String authHeader = request.getHeader("Authorization");
        boolean bearerHeader = authHeader != null && authHeader.startsWith("Bearer ");
        // Bearer 豁免限定：仅【无任何会话 cookie】时合法 Bearer 前缀头豁免（预览/嵌入通道无 cookie
        // 自动携带语义，04BE §A.7）；混合请求（cookie + Bearer 头）回落双提交判定——防跨站伪造头绕过
        if (bearerHeader && !hasSession) {
            chain.doFilter(request, response);
            return;
        }
        // 匿名请求（无会话凭证且无 csrf cookie）：放行给 JwtAuthFilter 判 401（认证边界语义优先）
        if (!hasSession && !hasCsrf) {
            // 登录保护强制前置：无 csrf cookie 的登录不匿名放行——先过 Origin（跨站登录 CSRF 拦截）；
            // 同源正常浏览器登录页均已先调 GET /api/auth/csrf 取得 cookie 走完整双提交
            if (LOGIN_PATH.equals(path)) {
                if (!isSameOrigin(request)) {
                    writeError(response, "CSRF_ORIGIN_REJECTED", "登录请求来源校验失败");
                    return;
                }
                chain.doFilter(request, response);
                return;
            }
            chain.doFilter(request, response);
            return;
        }

        // 第一道：双提交（会话请求必须有等值头；预签过 csrf 的登录请求同样受双提交保护）
        String header = request.getHeader("X-CSRF-Token");
        if (!hasCsrf
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

    /** Origin/Referer 精确匹配（scheme://host:port 全等；缺失即拒——非浏览器客户端走 Bearer）。
     *  Referer 非法 URI 解析失败按不匹配拒绝（不抛 500——恶意输入不产生服务器异常）。 */
    private boolean isSameOrigin(HttpServletRequest request) {
        String target = originOf(request);
        String origin = request.getHeader("Origin");
        if (origin != null && !origin.isBlank()) {
            return origin.equals(target) || DEV_ORIGINS.contains(origin);
        }
        String referer = request.getHeader("Referer");
        if (referer != null && !referer.isBlank()) {
            try {
                URI uri = URI.create(referer);
                if (uri.getRawAuthority() == null) {
                    return false;
                }
                String refererOrigin = uri.getScheme() + "://" + uri.getRawAuthority();
                return refererOrigin.equals(target) || DEV_ORIGINS.contains(refererOrigin);
            } catch (IllegalArgumentException e) {
                return false;   // 非法 Referer 一律按不匹配拒绝
            }
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
