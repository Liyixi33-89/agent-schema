package com.schema.bootstrap;

import com.schema.iam.infrastructure.security.JwtCodec;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * M11 应用域 HTTP 安全链集成测试（真实过滤器链 + 真实 PG）：
 * 同租户越权（应用级权限闸）/ 删除确认协议（precheck + confirmValue）/ 成员端点鉴权 / 导航读面鉴权。
 * 与 AppServiceIT（服务层）互补——本类锁定 HTTP 边界行为。
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
class AppHttpSecurityIT {

    @Autowired
    private WebApplicationContext ctx;

    @Autowired
    private JwtCodec jwt;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private com.schema.app.application.AppService apps;

    private MockMvc mvc;

    private long appId;
    private long adminId;
    private long outsiderId;
    private String appName;

    @BeforeAll
    void setUp() {
        mvc = MockMvcBuilders.webAppContextSetup(ctx)
                .addFilters(ctx.getBeansOfType(jakarta.servlet.Filter.class).values()
                        .toArray(new jakarta.servlet.Filter[0]))
                .build();
        adminId = ensureUser("app_admin_http");
        outsiderId = ensureUser("app_outsider_http");
        // 管理员身份创建应用（自动 app_admin）
        long stamp = System.nanoTime();
        appName = "HTTP安全应用_" + stamp;
        TenantInfo admin = new TenantInfo(1, 0, adminId);
        MapHolder created = TenantContext.with(admin, () -> {
            var r = apps.create(appName, null, "HTTP 安全链测试", null, "127.0.0.1", "ua");
            return new MapHolder(((Number) r.get("appId")).longValue());
        });
        appId = created.value;
        TenantContext.clear();
    }

    /** 包装 holder（lambda 捕获需 effectively final）。 */
    private record MapHolder(long value) {
    }

    private long ensureUser(String account) {
        List<Long> existing = jdbc.query(
                "SELECT id FROM sys_user WHERE tenant_id=1 AND account=? LIMIT 1",
                (rs, i) -> rs.getLong(1), account);
        if (!existing.isEmpty()) {
            return existing.get(0);
        }
        var encoder = new org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder();
        jdbc.update("INSERT INTO sys_user (tenant_id, account, name, password_hash, status, "
                        + "must_change_password) VALUES (1, ?, ?, ?, 'ACTIVE', false)",
                account, account, encoder.encode("HttpIt!2026x"));
        return jdbc.queryForObject("SELECT id FROM sys_user WHERE account=?", Long.class, account);
    }

    private String access(long userId) {
        return jwt.issueAccess(userId, 1);
    }

    // ---------- 应用级权限闸：同租户非成员 ----------

    @Test
    void outsiderCannotReadDetailOrNav() throws Exception {
        String token = access(outsiderId);
        // 详情 403
        mvc.perform(get("/api/apps/" + appId).header("Authorization", "Bearer " + token))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("PERM_DENIED"));
        // 设计面导航（filtered=false）403
        mvc.perform(get("/api/apps/" + appId + "/nav").header("Authorization", "Bearer " + token))
                .andExpect(status().isForbidden());
        // 成员列表 403
        mvc.perform(get("/api/apps/" + appId + "/members").header("Authorization", "Bearer " + token))
                .andExpect(status().isForbidden());
    }

    @Test
    void outsiderCannotWriteLifecycleOrMembers() throws Exception {
        String token = access(outsiderId);
        // 改名 403
        mvc.perform(put("/api/apps/" + appId).header("Authorization", "Bearer " + token)
                        .contentType("application/json").content("{\"name\":\"越权改名\"}"))
                .andExpect(status().isForbidden());
        // 归档 403
        mvc.perform(post("/api/apps/" + appId + "/archive").header("Authorization", "Bearer " + token))
                .andExpect(status().isForbidden());
        // 删除预检 403
        mvc.perform(post("/api/apps/" + appId + "/delete-precheck")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isForbidden());
        // 删除（即便带对应用名也须先过权限闸）403
        mvc.perform(delete("/api/apps/" + appId).header("Authorization", "Bearer " + token)
                        .contentType("application/json")
                        .content("{\"confirmValue\":\"" + appName + "\"}"))
                .andExpect(status().isForbidden());
        assertEquals("ACTIVE", jdbc.queryForObject(
                "SELECT status FROM app WHERE id=?", String.class, appId));
        // 成员写入 403
        mvc.perform(post("/api/apps/" + appId + "/members").header("Authorization", "Bearer " + token)
                        .contentType("application/json")
                        .content("{\"userId\":" + outsiderId + ",\"roles\":[\"user\"]}"))
                .andExpect(status().isForbidden());
    }

    // ---------- 删除确认协议（高摩擦：confirmValue=完整应用名） ----------

    @Test
    void deleteRequiresConfirmValue() throws Exception {
        String token = access(adminId);
        // 无 body → 409 确认缺失
        mvc.perform(delete("/api/apps/" + appId).header("Authorization", "Bearer " + token))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("APP_DELETE_CONFIRM_REQUIRED"));
        // 错误应用名 → 409
        mvc.perform(delete("/api/apps/" + appId).header("Authorization", "Bearer " + token)
                        .contentType("application/json").content("{\"confirmValue\":\"错的\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("APP_DELETE_CONFIRM_REQUIRED"));
        // precheck 管理员可用：返回影响面 + confirmField
        mvc.perform(post("/api/apps/" + appId + "/delete-precheck")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.confirmField").value("name"))
                .andExpect(jsonPath("$.impact.appName").value(appName));
        // 应用仍未删除（确认失败不产生副作用）
        assertEquals("ACTIVE", jdbc.queryForObject(
                "SELECT status FROM app WHERE id=?", String.class, appId));
    }

    // ---------- 管理员正向通路（非越权回归） ----------

    @Test
    void adminCanReadDetailAndMembers() throws Exception {
        String token = access(adminId);
        mvc.perform(get("/api/apps/" + appId).header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.name").value(appName));
        mvc.perform(get("/api/apps/" + appId + "/members").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.list[0].roles[0]").value("app_admin"));
    }
}
