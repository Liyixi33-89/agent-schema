package com.schema.bootstrap;

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

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * CsrfFilter 第二轮收口反例测试（真实过滤器链 + 真实 PG）：
 * 1) Cookie+Bearer 混合请求不再豁免双提交（伪造 Bearer 头 + 受害 cookie 的跨站向量）；
 * 2) 会话凭证判定含 schema_rt（access 过期 refresh 仍在时双提交独立执行）；
 * 3) 登录端点无 csrf cookie 时强制 Origin 校验（跨站登录 CSRF 拦截；同源放行）；
 * 4) 非法 Referer 不产生 500（按不匹配拒绝）。
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
class CsrfHardeningIT {

    @Autowired
    private WebApplicationContext ctx;

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

    @BeforeEach
    void ensureUser() {
        jdbc.update("DELETE FROM sys_refresh_token WHERE user_id IN "
                + "(SELECT id FROM sys_user WHERE account='csrf_user')");
        jdbc.update("DELETE FROM sys_user WHERE account='csrf_user'");
        jdbc.update("INSERT INTO sys_user (tenant_id, account, name, password_hash, status) "
                + "VALUES (1, 'csrf_user', 'Csrf', '" + hash("InitPass123") + "', 'ACTIVE')");
        userId = jdbc.queryForObject("SELECT id FROM sys_user WHERE account='csrf_user'", Long.class);
    }

    private static String hash(String raw) {
        return new org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder().encode(raw);
    }

    /** 登录（匿名 csrf → 双提交 + Origin）。 */
    private Cookie[] loginCookies() throws Exception {
        MvcResult csrf = mvc.perform(
                        org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get("/api/auth/csrf"))
                .andExpect(status().isOk()).andReturn();
        Cookie csrfCookie = parseCookies(csrf).get(SessionCookies.CSRF);
        MvcResult result = mvc.perform(post("/api/auth/login")
                        .cookie(csrfCookie)
                        .header("X-CSRF-Token", csrfCookie.getValue())
                        .header("Origin", "http://localhost")
                        .contentType("application/json")
                        .content("{\"username\":\"csrf_user\",\"password\":\"InitPass123\"}"))
                .andExpect(status().isOk())
                .andReturn();
        return parseCookies(result).values().toArray(new Cookie[0]);
    }

    private static java.util.Map<String, Cookie> parseCookies(MvcResult result) {
        java.util.Map<String, Cookie> map = new java.util.LinkedHashMap<>();
        for (String h : result.getResponse().getHeaders("Set-Cookie")) {
            int eq = h.indexOf('=');
            int semi = h.indexOf(';', eq + 1);
            String name = h.substring(0, eq);
            String value = semi > 0 ? h.substring(eq + 1, semi) : h.substring(eq + 1);
            Cookie c = new Cookie(name, value);
            c.setPath(h.contains("Path=/api/auth") ? "/api/auth" : "/");
            map.put(name, c);
        }
        return map;
    }

    private static Cookie cookie(Cookie[] cookies, String name) {
        for (Cookie c : cookies) {
            if (name.equals(c.getName())) {
                return c;
            }
        }
        return null;
    }

    // ---------- 1) 混合请求（cookie + Bearer 头）不再豁免 ----------

    @Test
    void cookiePlusForgedBearerHeaderStillRequiresDoubleSubmit() throws Exception {
        Cookie[] cookies = loginCookies();
        // 受害 cookie + 伪造 Bearer 头 + 无 csrf 头 → 403（旧逻辑：Bearer 前缀即豁免——已闭合）
        mvc.perform(post("/api/org/members/" + userId + "/roles")
                        .cookie(cookies)
                        .header("Authorization", "Bearer forged-token-by-attacker")
                        .header("Origin", "http://localhost")
                        .contentType("application/json")
                        .content("{\"appId\":1,\"roleIds\":[]}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("CSRF_TOKEN_REJECTED"));
        // 纯 Bearer（无任何会话 cookie）仍豁免——预览/嵌入通道不受影响
        String access = cookie(cookies, SessionCookies.AT).getValue();
        mvc.perform(post("/api/auth/refresh")
                        .header("Authorization", "Bearer " + access))
                .andExpect(status().isUnauthorized());   // 业务 401（REFRESH_REVOKED）——CSRF 层已放行
    }

    // ---------- 2) 会话凭证判定含 schema_rt ----------

    @Test
    void rtCookieAloneStillEnforcesDoubleSubmit() throws Exception {
        Cookie[] cookies = loginCookies();
        // 真实场景模拟：access 过期但浏览器仍持 rt + csrf 两枚 cookie
        Cookie[] rtPlusCsrf = new Cookie[]{cookie(cookies, SessionCookies.RT), cookie(cookies, SessionCookies.CSRF)};
        // 仅 rt + csrf cookie、无 csrf 头 → 403（不得落入匿名放行分支）
        mvc.perform(post("/api/auth/refresh")
                        .cookie(rtPlusCsrf)
                        .header("Origin", "http://localhost"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("CSRF_TOKEN_REJECTED"));
        // 带 csrf 头等值 → 放行（业务 200——容忍窗口内滚动签发）
        mvc.perform(post("/api/auth/refresh")
                        .cookie(rtPlusCsrf)
                        .header("X-CSRF-Token", cookie(cookies, SessionCookies.CSRF).getValue())
                        .header("Origin", "http://localhost"))
                .andExpect(status().isOk());
    }

    // ---------- 3) 登录端点无 csrf cookie 强制 Origin ----------

    @Test
    void loginWithoutCsrfCookieRejectsCrossOrigin() throws Exception {
        // 跨站 Origin + 无 csrf cookie → 403 CSRF_ORIGIN_REJECTED（登录 CSRF 拦截）
        mvc.perform(post("/api/auth/login")
                        .header("Origin", "https://evil.example.com")
                        .contentType("application/json")
                        .content("{\"username\":\"csrf_user\",\"password\":\"InitPass123\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("CSRF_ORIGIN_REJECTED"));
        // 同源 Origin + 无 csrf cookie → 放行（正常浏览器直登；业务失败计数兜底）
        mvc.perform(post("/api/auth/login")
                        .header("Origin", "http://localhost")
                        .contentType("application/json")
                        .content("{\"username\":\"csrf_user\",\"password\":\"wrong\"}"))
                .andExpect(status().isUnauthorized());
    }

    // ---------- 4) 非法 Referer 不产生 500 ----------

    @Test
    void malformedRefererIsRejectedNot500() throws Exception {
        Cookie[] cookies = loginCookies();
        Cookie csrfCookie = cookie(cookies, SessionCookies.CSRF);
        // Referer 非法 URI：按不匹配拒绝（403），不抛 500
        MvcResult result = mvc.perform(put("/api/me/password")
                        .cookie(cookies)
                        .header("X-CSRF-Token", csrfCookie.getValue())
                        .header("Referer", "::::not-a-valid-uri::::")
                        .contentType("application/json")
                        .content("{\"oldPassword\":\"wrong\",\"newPassword\":\"NewPass456\"}"))
                .andExpect(status().isForbidden())
                .andReturn();
        assertTrue(result.getResponse().getContentAsString().contains("CSRF_ORIGIN_REJECTED"));
    }
}
