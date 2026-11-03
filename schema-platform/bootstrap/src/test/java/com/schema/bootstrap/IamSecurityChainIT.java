package com.schema.bootstrap;

import com.schema.iam.infrastructure.security.JwtCodec;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.BeforeAll;
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
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * M3 安全链集成测试（真实过滤器链 + 真实 PG，03BE §7）：
 * 无凭证 401 / 普通成员管理端点 403 / HTTP 租户头绑定 / 强制改密放行名单 /
 * 停用用户凭证失效 / refresh 并发一次性消费。
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
class IamSecurityChainIT {

    @Autowired
    private WebApplicationContext ctx;

    @Autowired
    private JwtCodec jwt;

    @Autowired
    private JdbcTemplate jdbc;

    private MockMvc mvc;

    private long adminId;
    private long plainId;
    private long mustChangeId;
    private long disabledId;
    private String plainRefresh;

    @BeforeAll
    void setUp() {
        // 全量过滤器链（JwtAuthFilter/TenantContextFilter/SecurityHeadersFilter 必须真实参与）
        mvc = MockMvcBuilders.webAppContextSetup(ctx)
                .addFilters(ctx.getBeansOfType(jakarta.servlet.Filter.class).values()
                        .toArray(new jakarta.servlet.Filter[0]))
                .build();
        jdbc.update("DELETE FROM sys_user_role");
        jdbc.update("DELETE FROM sys_role_permission");
        jdbc.update("DELETE FROM sys_role_data_scope");
        jdbc.update("DELETE FROM sys_refresh_token");
        jdbc.update("DELETE FROM sys_audit_log");
        jdbc.update("DELETE FROM sys_role");
        jdbc.update("DELETE FROM sys_dept");
        jdbc.update("DELETE FROM sys_user");

        // 种子：org_admin 角色携带 org:manage 权限点（租户 1，应用 1）
        jdbc.update("INSERT INTO sys_role (tenant_id, code, name, role_type, app_id) "
                + "VALUES (1, 'org_admin', '组织管理员', 'APP', 1)");
        Long roleId = jdbc.queryForObject(
                "SELECT id FROM sys_role WHERE tenant_id=1 AND code='org_admin'", Long.class);
        jdbc.update("INSERT INTO sys_role_permission (role_id, resource_type, resource_id, action) "
                + "VALUES (?, 'ACTION', 0, 'org:manage')", roleId);

        adminId = insertUser("admin_sec", 1);
        plainId = insertUser("plain_sec", 1);
        mustChangeId = insertUser("mustchange_sec", 1);
        disabledId = insertUser("disabled_sec", 1);
        Long otherTenantUser = insertUser("tenant2_sec", 2);
        jdbc.update("UPDATE sys_user SET must_change_password=true WHERE id=?", mustChangeId);
        jdbc.update("UPDATE sys_user SET status='DISABLED' WHERE id=?", disabledId);
        jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", adminId, roleId);
        // 普通用户挂一个无权限点角色（判定链真实走查而非空角色短路）
        jdbc.update("INSERT INTO sys_role (tenant_id, code, name, role_type, app_id) "
                + "VALUES (1, 'viewer', '只读', 'APP', 1)");
        Long viewerRoleId = jdbc.queryForObject(
                "SELECT id FROM sys_role WHERE tenant_id=1 AND code='viewer'", Long.class);
        jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", plainId, viewerRoleId);

        // 普通用户的有效 refresh（并发消费测试用）
        plainRefresh = "plain-refresh-token-" + System.nanoTime();
        jdbc.update("INSERT INTO sys_refresh_token (tenant_id, user_id, token_hash, expires_at) "
                        + "VALUES (1, ?, ?, now() + interval '7 days')",
                plainId, JwtCodec.hashRefreshToken(plainRefresh));
    }

    private Long insertUser(String account, long tenantId) {
        jdbc.update("INSERT INTO sys_user (tenant_id, account, name, password_hash, status) "
                + "VALUES (?, ?, ?, ?, 'ACTIVE')", tenantId, account, account, "bcrypt-hash");
        return jdbc.queryForObject("SELECT id FROM sys_user WHERE account=?", Long.class, account);
    }

    private String access(long userId, long tenantId) {
        return jwt.issueAccess(userId, tenantId);
    }

    // ---------- 03BE §7：无凭证强制 401（认证边界闭环） ----------

    @Test
    void noCredentialIsRejectedOnBusinessEndpoints() throws Exception {
        mvc.perform(get("/api/me")).andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("UNAUTHORIZED"));
        mvc.perform(post("/api/org/members").contentType("application/json").content("{}"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void publicEndpointsStayOpenWithoutToken() throws Exception {
        mvc.perform(post("/api/auth/logout").contentType("application/json").content("{}"))
                .andExpect(status().isOk());
        mvc.perform(post("/api/auth/refresh").contentType("application/json")
                        .content("{\"refreshToken\":\"unknown-token\"}"))
                .andExpect(status().isUnauthorized());   // 业务拒绝 ≠ 认证拦截
    }

    // ---------- v0.4 收口：CSRF 边界收紧（CsrfFilter） ----------

    /** 从响应 Set-Cookie 头解析指定 cookie（手工头不进 getCookies()）。 */
    private static Cookie parseCookie(MvcResult result, String name) {
        for (String h : result.getResponse().getHeaders("Set-Cookie")) {
            if (h.startsWith(name + "=")) {
                int eq = name.length() + 1;
                int semi = h.indexOf(';', eq);
                Cookie c = new Cookie(name, semi > 0 ? h.substring(eq, semi) : h.substring(eq));
                c.setPath("/");
                return c;
            }
        }
        throw new IllegalStateException("响应缺 cookie: " + name);
    }

    @Test
    void crossOriginCsrfRequestIsRejected() throws Exception {
        // 双提交等值但 Origin 不匹配 → 403 CSRF_ORIGIN_REJECTED（精确匹配——子串绕过不再可能）
        MvcResult csrf = mvc.perform(get("/api/auth/csrf")).andExpect(status().isOk()).andReturn();
        Cookie csrfCookie = parseCookie(csrf, "schema_csrf");
        String evilOrigin = "http://localhost:8080.evil.example.com";   // 旧 contains 匹配会放行
        mvc.perform(post("/api/auth/login")
                        .cookie(csrfCookie)
                        .header("X-CSRF-Token", csrfCookie.getValue())
                        .header("Origin", evilOrigin)
                        .contentType("application/json")
                        .content("{\"username\":\"admin_sec\",\"password\":\"whatever1\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("CSRF_ORIGIN_REJECTED"));
        // 同构造但 Origin 缺失（无 Referer）→ 同样 403（缺失即拒）
        MvcResult csrf2 = mvc.perform(get("/api/auth/csrf")).andExpect(status().isOk()).andReturn();
        Cookie csrfCookie2 = parseCookie(csrf2, "schema_csrf");
        mvc.perform(post("/api/auth/login")
                        .cookie(csrfCookie2)
                        .header("X-CSRF-Token", csrfCookie2.getValue())
                        .contentType("application/json")
                        .content("{\"username\":\"admin_sec\",\"password\":\"whatever1\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("CSRF_ORIGIN_REJECTED"));
    }

    @Test
    void fakeAuthorizationHeaderDoesNotBypassCsrf() throws Exception {
        // 非 Bearer 形态的 Authorization 头不豁免双提交——但有 csrf cookie 时必须走双提交判定：
        // 头缺失 → 403 CSRF_TOKEN_REJECTED（旧逻辑任意 Authorization 头一刀切放行的漏洞收口）
        MvcResult csrf = mvc.perform(get("/api/auth/csrf")).andExpect(status().isOk()).andReturn();
        Cookie csrfCookie = parseCookie(csrf, "schema_csrf");
        mvc.perform(post("/api/org/members")
                        .cookie(csrfCookie)   // 有 csrf cookie（预签过）→ 要求双提交
                        .header("Authorization", "Basic Zm9vOmJhcg==")   // 非 Bearer 伪造头
                        .header("Origin", "http://localhost")
                        .contentType("application/json").content("{}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("CSRF_TOKEN_REJECTED"));
        // 匿名无任何 cookie 的请求：放行给认证层 401（认证边界语义优先——非 CSRF 403）
        mvc.perform(post("/api/org/members")
                        .header("Authorization", "Basic Zm9vOmJhcg==")
                        .contentType("application/json").content("{}"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void sessionCookieRequestWithoutCsrfHeaderIsRejected() throws Exception {
        // 已登录会话（schema_at cookie）+ csrf cookie 存在但头缺失 → 403（不再「无头放行」）
        // 构造：真实登录拿三件套
        MvcResult csrf = mvc.perform(get("/api/auth/csrf")).andExpect(status().isOk()).andReturn();
        Cookie csrfCookie = parseCookie(csrf, "schema_csrf");
        // admin_sec 种子密码哈希是占位 'bcrypt-hash'——直接造一次成功登录需要真实哈希；
        // 此处用普通成员 plain_sec 不行（同为占位）。改为直接验证逻辑：会话 cookie + csrf cookie + 无头
        // 用 jwt 签发 access 构造 schema_at cookie（浏览器等价物）
        Cookie atCookie = new Cookie("schema_at", access(plainId, 1));
        atCookie.setPath("/");
        mvc.perform(post("/api/org/members/" + plainId + "/roles")
                        .cookie(atCookie, csrfCookie)
                        .header("Origin", "http://localhost")
                        .contentType("application/json")
                        .content("{\"appId\":1,\"roleIds\":[]}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("CSRF_TOKEN_REJECTED"));
        // 同请求带头且等值 → 通过 CSRF 层（业务层再按权限判定 403 PERM_DENIED）
        mvc.perform(post("/api/org/members/" + plainId + "/roles")
                        .cookie(atCookie, csrfCookie)
                        .header("X-CSRF-Token", csrfCookie.getValue())
                        .header("Origin", "http://localhost")
                        .contentType("application/json")
                        .content("{\"appId\":1,\"roleIds\":[]}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("PERM_DENIED"));
    }

    // ---------- 03BE §7：管理端点权限判定（普通成员 403 PERM_DENIED） ----------

    @Test
    void plainMemberCannotCreateResetOrGrant() throws Exception {
        String token = access(plainId, 1);
        mvc.perform(post("/api/org/members").header("Authorization", "Bearer " + token)
                        .contentType("application/json")
                        .content("{\"username\":\"x_member\",\"name\":\"X\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("PERM_DENIED"));
        mvc.perform(post("/api/auth/reset-password").header("Authorization", "Bearer " + token)
                        .contentType("application/json").content("{\"userId\":" + plainId + "}"))
                .andExpect(status().isForbidden());
        mvc.perform(post("/api/org/members/" + plainId + "/roles")
                        .header("Authorization", "Bearer " + token)
                        .contentType("application/json").content("{\"appId\":1,\"roleIds\":[]}"))
                .andExpect(status().isForbidden());
    }

    @Test
    void adminWithPermPointCanCreateMember() throws Exception {
        String token = access(adminId, 1);
        mvc.perform(post("/api/org/members").header("Authorization", "Bearer " + token)
                        .contentType("application/json")
                        .content("{\"username\":\"created_by_admin\",\"name\":\"C\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.initialPassword").isNotEmpty());
    }

    // ---------- 03BE §7：JWT claim 与 HTTP 租户头绑定 ----------

    @Test
    void tenantHeaderMismatchIsRejectedAndAudited() throws Exception {
        String token = access(adminId, 1);
        mvc.perform(get("/api/me").header("Authorization", "Bearer " + token)
                        .header("X-Tenant-Id", "2"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("TENANT_MISMATCH"));
        Long audits = jdbc.queryForObject(
                "SELECT count(*) FROM sys_audit_log WHERE event_type='SECURITY' "
                        + "AND diff->>'reason'='TENANT_MISMATCH'", Long.class);
        assertTrue(audits >= 1, "租户不匹配必须记安全审计");
    }

    // ---------- 03BE §7：强制改密放行名单（HTTP 链） ----------

    @Test
    void mustChangePasswordBlocksBusinessButAllowsAllowlist() throws Exception {
        String token = access(mustChangeId, 1);
        // 业务端点拦截
        mvc.perform(post("/api/org/members").header("Authorization", "Bearer " + token)
                        .contentType("application/json").content("{}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("PASSWORD_CHANGE_REQUIRED"));
        // 放行名单：me 可访问
        mvc.perform(get("/api/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk());
        // 放行名单：改密本体可访问（密码不匹配走业务 401，而非 403 拦截）
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                        .put("/api/me/password").header("Authorization", "Bearer " + token)
                        .contentType("application/json")
                        .content("{\"oldPassword\":\"wrong\",\"newPassword\":\"NewPass123\"}"))
                .andExpect(status().isUnauthorized());
    }

    // ---------- 03BE §7：停用用户凭证即时失效 ----------

    @Test
    void disabledUserTokenIsRejected() throws Exception {
        String token = access(disabledId, 1);
        mvc.perform(get("/api/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isUnauthorized());
    }

    // ---------- 03BE §7：refresh 并发消费（v0.4 ±10s 容忍窗口内全部成功——多标签不误踢） ----------

    @Test
    void concurrentRefreshWithinToleranceAllSucceed() throws Exception {
        int threads = 8;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<Integer>> futures = new java.util.ArrayList<>();
        for (int i = 0; i < threads; i++) {
            futures.add(pool.submit(() -> {
                start.await();
                try {
                    return mvc.perform(post("/api/auth/refresh").contentType("application/json")
                                    .content("{\"refreshToken\":\"" + plainRefresh + "\"}"))
                            .andReturn().getResponse().getStatus();
                } catch (Exception e) {
                    return -1;
                }
            }));
        }
        start.countDown();
        int ok = 0;
        for (Future<Integer> f : futures) {
            if (f.get(15, TimeUnit.SECONDS) == 200) {
                ok++;
            }
        }
        pool.shutdown();
        // v0.4 §4.1（2026-11-03 收口）：首次消费后 10s 容忍窗口内同 token 重放全部成功；
        // csrf 复用首次轮换结果（同组三件套语义——并发请求拿到一致的新会话）
        assertEquals(threads, ok, "容忍窗口内并发刷新必须全部成功");
        // 容忍窗口语义下并发刷新不记重放审计（偶发竞态窗口判定偏差允许 ≤1 条——宁可多记不可漏记）
        Long replays = jdbc.queryForObject(
                "SELECT count(*) FROM sys_audit_log WHERE event_type='SECURITY' "
                        + "AND diff->>'reason'='REFRESH_REPLAY'", Long.class);
        assertTrue(replays <= 1, "容忍窗口内并发刷新不得逐次记重放审计");
    }

    @Test
    void concurrentRefreshWithinToleranceReturnsConsistentCsrf() throws Exception {
        // 同结果一致性（2026-11-03 收口）：窗口内重放的 csrf 必须与首次轮换一致
        org.springframework.test.web.servlet.MvcResult first =
                mvc.perform(post("/api/auth/refresh").contentType("application/json")
                                .content("{\"refreshToken\":\"" + plainRefresh + "\"}"))
                        .andReturn();
        String firstCsrf = csrfCookieOf(first);
        org.springframework.test.web.servlet.MvcResult replay =
                mvc.perform(post("/api/auth/refresh").contentType("application/json")
                                .content("{\"refreshToken\":\"" + plainRefresh + "\"}"))
                        .andReturn();
        String replayCsrf = csrfCookieOf(replay);
        assertEquals(firstCsrf, replayCsrf, "容忍窗口内重放必须返回同一次轮换的 csrf");
    }

    /** 从响应 Set-Cookie 头解析 schema_csrf 值。 */
    private String csrfCookieOf(org.springframework.test.web.servlet.MvcResult result) {
        for (jakarta.servlet.http.Cookie c : result.getResponse().getCookies()) {
            if ("schema_csrf".equals(c.getName())) {
                return c.getValue();
            }
        }
        return null;
    }

    @Test
    void staleRefreshOutsideToleranceIsRejectedAndAudited() throws Exception {
        // 构造已消费且超出容忍窗口的行：直接置 consumed_at 为 1 分钟前
        String stale = "stale-refresh-" + System.nanoTime();
        jdbc.update("INSERT INTO sys_refresh_token (tenant_id, user_id, token_hash, expires_at, "
                        + "revoked, revoked_at, consumed_at) VALUES (1, ?, ?, now() + interval '7 days', "
                        + "true, now() - interval '1 minute', now() - interval '1 minute')",
                plainId, JwtCodec.hashRefreshToken(stale));
        mvc.perform(post("/api/auth/refresh").contentType("application/json")
                        .content("{\"refreshToken\":\"" + stale + "\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("REFRESH_REVOKED"));
        Long replays = jdbc.queryForObject(
                "SELECT count(*) FROM sys_audit_log WHERE event_type='SECURITY' "
                        + "AND diff->>'reason'='REFRESH_REPLAY'", Long.class);
        assertTrue(replays >= 1, "窗口外重放必须记安全审计");
    }

    // ---------- 03BE §7：审计独立事务（拒绝路径留痕） ----------

    @Test
    void rejectPathAuditsSurviveTransactionRollback() {
        // 未知账号登录 → 主事务抛异常回滚，SECURITY 审计必须仍存在（REQUIRES_NEW）
        // （第二轮收口：登录请求须带同源 Origin 过 CsrfFilter——跨站/缺失即 403 不达业务层）
        try {
            mvc.perform(post("/api/auth/login").contentType("application/json")
                    .header("Origin", "http://localhost")
                    .content("{\"username\":\"ghost_user\",\"password\":\"whatever1\"}"));
        } catch (Exception ignored) {
            // 状态断言不是本用例重点
        }
        Map<String, Object> audit = jdbc.queryForMap(
                "SELECT count(*) AS c FROM sys_audit_log WHERE event_type='SECURITY' "
                        + "AND resource_id='ghost_user' AND diff->>'reason'='LOGIN_UNKNOWN_ACCOUNT'");
        assertTrue(((Number) audit.get("c")).longValue() >= 1,
                "拒绝路径审计不得随主事务回滚丢失");
    }
}
