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

    /**
     * CSRF/会话 cookie 是否带 {@code Secure} 属性。
     *
     * ## 为什么要这个开关
     * 原实现把 {@code Secure} 硬编码进三处 Set-Cookie。注释假设「要么 localhost
     * （浏览器忽略 Secure），要么生产 HTTPS」——但**存在第三种真实场景**：
     * HTTP + 公网 IP 的测试/内网环境。
     *
     * 该场景下浏览器**拒绝保存**带 Secure 的 cookie（HTTP 非安全上下文），
     * 于是 `GET /api/auth/csrf` 的 Set-Cookie 被丢弃 → 登录请求缺 CSRF
     * → 恒返回 `CSRF_TOKEN_REJECTED`，**登录完全不可用**。
     * （2026-11-26 在 111.231.57.177 实测踩到：/designer 登录页反复提示
     *  「登录已过期，请重新登录」，后端日志为 CSRF_TOKEN_REJECTED。）
     *
     * ## 安全立场
     * **默认 true（保持 Secure）**——生产必须 HTTPS，不因本开关而放宽。
     * 只有显式设置环境变量 {@code COOKIE_INSECURE=1} 才降级，
     * 且该变量只应出现在临时 HTTP 环境（配置里有醒目注释）。
     * 这是「显式、可审计的降级」，不是默认松懈。
     *
     * ⚠️ 降级后 cookie 可被明文网络嗅探——仅限内网/临时测试使用。
     */
    private static final boolean SECURE = !"1".equals(System.getenv("COOKIE_INSECURE"));

    /** 会话 cookie 的 Secure 属性片段（空串=降级模式）。 */
    private static String secureAttr() {
        return SECURE ? "Secure; " : "";
    }

    /** 当前是否处于降级模式（测试与运维自检用）。 */
    public static boolean isInsecureCookieMode() {
        return !SECURE;
    }

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
                "HttpOnly; " + secureAttr() + "SameSite=Lax; Path=/");
        set(resp, RT, refreshToken, RT_MAX_AGE,
                "HttpOnly; " + secureAttr() + "SameSite=Strict; Path=/api/auth");
        set(resp, CSRF, csrfValue, RT_MAX_AGE,
                secureAttr() + "SameSite=Lax; Path=/");
    }

    /** 匿名 csrf 签发（登录页加载 GET /api/auth/csrf——登录 CSRF 防护，未绑定会话）。 */
    public static void issueCsrfOnly(HttpServletResponse resp, String csrfValue) {
        set(resp, CSRF, csrfValue, RT_MAX_AGE, secureAttr() + "SameSite=Lax; Path=/");
    }

    /** 登出：三枚 Max-Age=0 清除（属性与签发一致——不一致清除失效）。 */
    public static void clear(HttpServletResponse resp) {
        set(resp, AT, "", 0, "HttpOnly; " + secureAttr() + "SameSite=Lax; Path=/");
        set(resp, RT, "", 0, "HttpOnly; " + secureAttr() + "SameSite=Strict; Path=/api/auth");
        set(resp, CSRF, "", 0, secureAttr() + "SameSite=Lax; Path=/");
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
