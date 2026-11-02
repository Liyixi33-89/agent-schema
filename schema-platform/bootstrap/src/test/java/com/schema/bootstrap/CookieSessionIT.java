package com.schema.bootstrap;

import com.schema.iam.infrastructure.security.JwtCodec;
import com.schema.iam.infrastructure.security.SessionCookies;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * v0.4 Cookie 会话通道集成测试（真实过滤器链 + 真实 PG，03BE §4.1）：
 * Set-Cookie 三件套属性 / 匿名 csrf 初始化 / 双提交拒绝 / refresh cookie 携带与零 body /
 * 并发刷新 ±10s 容忍窗口 / pwdVersion 强失效 / Cookie 通道预览端点隔离 / CSRF 端点放行。
 */
@SpringBootTest(classes = com.schema.bootstrap.SchemaApplication.class)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(properties = {
        "spring.datasource.url=jdbc:postgresql://localhost:5432/schema_dev",
        "spring.datasource.username=schema_dev",
        "spring.datasource.password=schema_local_only",
        "spring.flyway.clean-disabled=false"
})
class CookieSessionIT {

    @Autowired
    private WebApplicationContext ctx;

    @Autowired
    private JwtCodec jwt;

    @Autowired
    private JdbcTemplate jdbc;

    private MockMvc mvc;

    private long userId;

    @BeforeAll
    void setUp() {
        mvc = MockMvcBuilders.webAppContextSetup(ctx)
                .addFilters(ctx.getBeansOfType(jakarta.servlet.Filter.class).values()
                        .toArray(new jakarta.servlet.Filter[0]))
                .build();
    }

    /** 幂等种子：其他 IT 类（共享库）可能清空 sys_user——每用例前确保 cookie_user 存在。 */
    @BeforeEach
    void ensureUser() {
        jdbc.update("DELETE FROM sys_refresh_token WHERE user_id IN "
                + "(SELECT id FROM sys_user WHERE account='cookie_user')");
        jdbc.update("DELETE FROM sys_user WHERE account='cookie_user'");
        jdbc.update("INSERT INTO sys_user (tenant_id, account, name, password_hash, status) "
                + "VALUES (1, 'cookie_user', 'Cookie', '" + hash("InitPass123") + "', 'ACTIVE')");
        userId = jdbc.queryForObject("SELECT id FROM sys_user WHERE account='cookie_user'", Long.class);
    }

    private static String hash(String raw) {
        return new org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder().encode(raw);
    }

    /** 真实登录流程：匿名 csrf → login（带头双提交 + Origin；返回三件套 cookie）。 */
    private Cookie[] loginCookies() throws Exception {
        MvcResult csrf = mvc.perform(get("/api/auth/csrf")).andExpect(status().isOk()).andReturn();
        Cookie csrfCookie = parseCookies(csrf).get(SessionCookies.CSRF);
        MvcResult result = mvc.perform(post("/api/auth/login")
                        .cookie(csrfCookie)
                        .header("X-CSRF-Token", csrfCookie.getValue())
                        .header("Origin", "http://localhost")   // v0.4 收口：Origin 缺失即拒
                        .contentType("application/json")
                        .content("{\"username\":\"cookie_user\",\"password\":\"InitPass123\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.accessToken").doesNotExist())   // v0.4 收口：响应体零凭证
                .andReturn();
        // 手工 Set-Cookie 头签发的 cookie 不进 MockMvc getCookies()——从响应头解析（浏览器真实行为模拟）
        Map<String, Cookie> issued = parseCookies(result);
        assertTrue(issued.size() >= 3, "登录必须签发三件套 Set-Cookie: " + issued.keySet());
        assertTrue(issued.containsKey(SessionCookies.AT), "缺 schema_at");
        assertTrue(issued.containsKey(SessionCookies.RT), "缺 schema_rt");
        assertTrue(issued.containsKey(SessionCookies.CSRF), "缺 schema_csrf");
        return issued.values().toArray(new Cookie[0]);
    }

    /** 从响应 Set-Cookie 头解析 cookie（手工头不进 getCookies()——模拟浏览器存储）。 */
    private static Map<String, Cookie> parseCookies(MvcResult result) {
        Map<String, Cookie> map = new java.util.LinkedHashMap<>();
        for (String h : result.getResponse().getHeaders("Set-Cookie")) {
            int eq = h.indexOf('=');
            int semi = h.indexOf(';', eq + 1);
            String name = h.substring(0, eq);
            String value = semi > 0 ? h.substring(eq + 1, semi) : h.substring(eq + 1);
            Cookie c = new Cookie(name, value);
            if (h.contains("Path=/api/auth")) {
                c.setPath("/api/auth");
            } else {
                c.setPath("/");
            }
            map.put(name, c);
        }
        return map;
    }

    private static jakarta.servlet.http.Cookie cookie(Cookie[] cookies, String name) {
        for (Cookie c : cookies) {
            if (name.equals(c.getName())) {
                return c;
            }
        }
        return null;
    }

    private static String cookieHeader(MvcResult result) {
        return result.getResponse().getHeader("Set-Cookie");
    }

    // ---------- Set-Cookie 三件套属性（03BE §4.1 表） ----------

    @Test
    void loginIssuesSessionCookiesWithSpecAttributes() throws Exception {
        // 无 csrf cookie 的登录走匿名放行（CsrfFilter 放行 + 业务正常）——验证认证边界不误伤
        MvcResult result = mvc.perform(post("/api/auth/login")
                        .contentType("application/json")
                        .content("{\"username\":\"cookie_user\",\"password\":\"InitPass123\"}"))
                .andExpect(status().isOk())
                .andReturn();
        List<String> headers = result.getResponse().getHeaders("Set-Cookie");
        assertTrue(headers.size() >= 3, "三件套必须逐枚 Set-Cookie");
        String joined = String.join("\n", headers);
        assertTrue(joined.contains("schema_at="), "缺 schema_at");
        assertTrue(joined.contains("schema_rt="), "缺 schema_rt");
        assertTrue(joined.contains("schema_csrf="), "缺 schema_csrf");
        // 属性逐项断言
        for (String h : headers) {
            if (h.startsWith("schema_at=")) {
                assertTrue(h.contains("HttpOnly") && h.contains("Secure")
                        && h.contains("SameSite=Lax") && h.contains("Path=/"));
            } else if (h.startsWith("schema_rt=")) {
                assertTrue(h.contains("HttpOnly") && h.contains("Secure")
                        && h.contains("SameSite=Strict") && h.contains("Path=/api/auth"));
            } else if (h.startsWith("schema_csrf=")) {
                assertTrue(!h.contains("HttpOnly"), "csrf 必须可读（双提交源）");
                assertTrue(h.contains("Secure") && h.contains("SameSite=Lax") && h.contains("Path=/"));
            }
        }
        // 三枚均 host-only（不设 Domain）
        assertTrue(!joined.contains("Domain="), "host-only 定版——不设 Domain");
        // 响应体不含任何凭证字段（v0.4 收口：零凭证不变量——refresh 与 access 均不得入体）
        String body = result.getResponse().getContentAsString();
        assertTrue(!body.contains("refreshToken"), "refresh 不得入响应体");
        assertTrue(!body.contains("accessToken"), "access 不得入响应体");
    }

    // ---------- 双提交校验（四道防线第一道） ----------

    @Test
    void stateChangingRequestWithoutCsrfHeaderIsRejected() throws Exception {
        Cookie[] cookies = loginCookies();
        // 缺 X-CSRF-Token 头：403 CSRF_TOKEN_REJECTED（同源 POST 无 Authorization 头）
        mvc.perform(post("/api/org/members/" + userId + "/roles")
                        .cookie(cookies)
                        .contentType("application/json")
                        .content("{\"appId\":1,\"roleIds\":[]}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("CSRF_TOKEN_REJECTED"));
        // GET 不校验双提交（幂等不受影响）
        mvc.perform(get("/api/me").cookie(cookies)).andExpect(status().isOk());
    }

    @Test
    void doubleSubmitWithMatchingHeaderPasses() throws Exception {
        Cookie[] cookies = loginCookies();
        Cookie csrfCookie = cookie(cookies, SessionCookies.CSRF);
        // 双提交等值放行（此请求密码策略业务拒绝也证明通过了 CSRF 层）
        mvc.perform(put("/api/me/password")
                        .cookie(cookies)
                        .header("X-CSRF-Token", csrfCookie.getValue())
                        .header("Origin", "http://localhost")
                        .contentType("application/json")
                        .content("{\"oldPassword\":\"wrong\",\"newPassword\":\"NewPass456\"}"))
                .andExpect(status().isUnauthorized())   // 原密码错 → 业务 401（CSRF 层已放行）
                .andExpect(jsonPath("$.code").value("UNAUTHORIZED"));
    }

    // ---------- refresh cookie 携带与零 body ----------

    @Test
    void refreshCarriesRtCookieWithZeroBody() throws Exception {
        Cookie[] cookies = loginCookies();
        // 零 body：schema_rt cookie 自动携带语义（MockMvc 显式传 cookie 模拟浏览器）
        mvc.perform(post("/api/auth/refresh")
                        .cookie(cookies)
                        .header("X-CSRF-Token", cookie(cookies, SessionCookies.CSRF).getValue())
                        .header("Origin", "http://localhost"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.accessToken").doesNotExist());   // v0.4 收口：刷新响应体零凭证
        // 无 cookie 无 body：401（cookie 缺失与吊销同判）
        mvc.perform(post("/api/auth/refresh"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("REFRESH_REVOKED"));
    }

    // ---------- 并发刷新 ±10s 容忍窗口（多标签不误踢） ----------

    @Test
    void concurrentRefreshWithinToleranceWindowAllSucceed() throws Exception {
        Cookie[] cookies = loginCookies();
        int threads = 4;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<Integer>> futures = new java.util.ArrayList<>();
        for (int i = 0; i < threads; i++) {
            futures.add(pool.submit(() -> {
                start.await();
                try {
                    return mvc.perform(post("/api/auth/refresh")
                                    .cookie(cookies)
                                    .header("X-CSRF-Token", cookie(cookies, SessionCookies.CSRF).getValue())
                                    .header("Origin", "http://localhost"))
                            .andReturn().getResponse().getStatus();
                } catch (Exception e) {
                    return -1;
                }
            }));
        }
        start.countDown();
        int ok = 0;
        for (Future<Integer> f : futures) {
            if (f.get(20, TimeUnit.SECONDS) == 200) {
                ok++;
            }
        }
        pool.shutdown();
        assertEquals(threads, ok, "容忍窗口内并发刷新全部成功（多标签不误踢）");
    }

    // ---------- pwdVersion 强失效（改密后旧 access 下一请求 401） ----------

    @Test
    void changedPasswordInvalidatesOldAccessImmediately() throws Exception {
        // 旧口径 access（pwdv=1 默认）：用应用真实 JwtCodec 签发模拟改密前会话
        String oldAccess = jwt.issueAccess(userId, 1);
        mvc.perform(get("/api/me").header("Authorization", "Bearer " + oldAccess))
                .andExpect(status().isOk());
        // 改密语义（pwdVersion 自增 +1；密码哈希同步换）
        jdbc.update("UPDATE sys_user SET password_hash=?, pwd_version=pwd_version+1, "
                + "must_change_password=false WHERE id=?", hash("NewPass456"), userId);
        // 旧 access（pwdv=1 ≠ 库值 2）下一请求 401（服务端会话状态校验）
        mvc.perform(get("/api/me").header("Authorization", "Bearer " + oldAccess))
                .andExpect(status().isUnauthorized());
    }

    // ---------- Cookie 通道预览端点隔离 ----------

    @Test
    void cookieCredentialIsRejectedOnPreviewEndpoints() throws Exception {
        Cookie[] cookies = loginCookies();
        mvc.perform(post("/api/preview/exchange").cookie(cookies)
                        .contentType("application/json").content("{\"grantId\":\"whatever\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("PREVIEW_CREDENTIAL_REJECTED"));
    }

    // ---------- csrf 匿名端点签发 ----------

    @Test
    void csrfEndpointIssuesAnonymousCsrfCookie() throws Exception {
        MvcResult result = mvc.perform(get("/api/auth/csrf"))
                .andExpect(status().isOk())
                .andReturn();
        String setCookie = cookieHeader(result);
        assertTrue(setCookie != null && setCookie.startsWith("schema_csrf="),
                "匿名 csrf 必须签发（登录 CSRF 防护）");
        assertTrue(setCookie.contains("Secure") && !setCookie.contains("HttpOnly"));
    }

    // ---------- 登出清 cookie（属性一致） ----------

    @Test
    void logoutClearsSessionCookies() throws Exception {
        Cookie[] cookies = loginCookies();
        MvcResult result = mvc.perform(post("/api/auth/logout")
                        .cookie(cookies)
                        .header("X-CSRF-Token", cookie(cookies, SessionCookies.CSRF).getValue())
                        .header("Origin", "http://localhost"))
                .andExpect(status().isOk())
                .andReturn();
        List<String> headers = result.getResponse().getHeaders("Set-Cookie");
        String joined = String.join("\n", headers);
        assertTrue(joined.contains("schema_at=") && joined.contains("Max-Age=0"),
                "schema_at 必须清除: " + joined);
        assertTrue(joined.contains("schema_rt="), "schema_rt 必须清除: " + joined);
        assertTrue(joined.contains("schema_csrf="), "schema_csrf 必须清除: " + joined);
        assertTrue(joined.contains("Path=/api/auth"), "rt 清除属性须与签发一致: " + joined);
    }
}
