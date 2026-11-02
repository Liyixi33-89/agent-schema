package com.schema.iam.infrastructure.security;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

/**
 * 会话 Cookie 三件套（v0.4 定版，03BE §4.1）：
 * schema_at    HttpOnly + Secure + SameSite=Lax + Path=/ + Max-Age=7200
 * schema_rt    HttpOnly + Secure + SameSite=Strict + Path=/api/auth + Max-Age=604800
 * schema_csrf  可读（非 HttpOnly）+ Secure + SameSite=Lax + Path=/ + Max-Age=604800
 *
 * 属性纪律：三枚均 host-only（不设 Domain——同源部署定版）；清除时属性必须与签发逐项一致
 * （Path/SameSite 不一致浏览器视为不同 cookie 清除失效）。
 * Secure 属性在 localhost 下被浏览器忽略属预期（03BE §4.1 部署前置——生产强制 HTTPS）。
 */
public final class SessionCookies {

    public static final String AT = "schema_at";
    public static final String RT = "schema_rt";
    public static final String CSRF = "schema_csrf";

    public static final long AT_MAX_AGE = JwtCodec.ACCESS_TTL_SECONDS;       // 2h
    public static final long RT_MAX_AGE = JwtCodec.REFRESH_TTL_SECONDS;     // 7d

    /** refresh 短窗口重放容忍（03BE §4.1 并发刷新——多标签不误踢）。 */
    public static final long REFRESH_TOLERANCE_SECONDS = 10;

    private SessionCookies() {
    }

    /** 登录/刷新/改密：滚动签发三件套（响应体不再返回 token——前端零凭证存储）。 */
    public static void issue(HttpServletResponse resp, String accessToken, String refreshToken,
            String csrfValue) {
        set(resp, AT, accessToken, AT_MAX_AGE,
                "HttpOnly; Secure; SameSite=Lax; Path=/");
        set(resp, RT, refreshToken, RT_MAX_AGE,
                "HttpOnly; Secure; SameSite=Strict; Path=/api/auth");
        set(resp, CSRF, csrfValue, RT_MAX_AGE,
                "Secure; SameSite=Lax; Path=/");
    }

    /** 匿名 csrf 签发（登录页加载 GET /api/auth/csrf——登录 CSRF 防护，未绑定会话）。 */
    public static void issueCsrfOnly(HttpServletResponse resp, String csrfValue) {
        set(resp, CSRF, csrfValue, RT_MAX_AGE, "Secure; SameSite=Lax; Path=/");
    }

    /** 登出：三枚 Max-Age=0 清除（属性与签发一致——不一致清除失效）。 */
    public static void clear(HttpServletResponse resp) {
        set(resp, AT, "", 0, "HttpOnly; Secure; SameSite=Lax; Path=/");
        set(resp, RT, "", 0, "HttpOnly; Secure; SameSite=Strict; Path=/api/auth");
        set(resp, CSRF, "", 0, "Secure; SameSite=Lax; Path=/");
    }

    private static void set(HttpServletResponse resp, String name, String value, long maxAge, String attrs) {
        // 手写 Set-Cookie（不走 jakarta Cookie API——SameSite 属性标准 API 不支持）
        resp.addHeader("Set-Cookie", name + "=" + value + "; Max-Age=" + maxAge + "; " + attrs);
    }

    /** 读 cookie 值（缺 null）。 */
    public static String read(HttpServletRequest req, String name) {
        Cookie[] cookies = req.getCookies();
        if (cookies == null) {
            return null;
        }
        for (Cookie c : cookies) {
            if (name.equals(c.getName())) {
                return c.getValue();
            }
        }
        return null;
    }

    /** 随机 csrf 值（128bit——Base64URL 22 字符）。 */
    public static String newCsrfValue() {
        byte[] bytes = new byte[16];
        new java.security.SecureRandom().nextBytes(bytes);
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
}
