package com.schema.bootstrap;

import com.schema.iam.infrastructure.security.JwtCodec;
import org.junit.jupiter.api.AfterAll;
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

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * M16 SLA 可用性看板 IT（PRD11 §2.1 统计口径锁定）：
 * - 可用性计算闭环：不可用分钟连续 ≥5 才计入（孤立 1 分钟抖动不计）；
 * - 维护窗口从分母扣除（不从不可用分钟扣）——excludedMinutes 口径；
 * - 零样本 availability=null（采样中——不用编译成功率代替 SLA）；
 * - 维护窗口纪律：72h 提前量 / 单次 ≤2h / 每月 ≤1 次（紧急例外）；
 * - org:manage 权限闸：普通用户 403。
 * 前置：docker compose up -d postgres。
 */
@SpringBootTest(classes = com.schema.bootstrap.SchemaApplication.class)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(properties = {
        "spring.datasource.url=jdbc:postgresql://${IT_DB_HOST:localhost}:${IT_DB_PORT:5432}/${IT_DB_NAME:schema_dev}",
        "spring.datasource.username=${IT_DB_USER:schema_dev}",
        "spring.datasource.password=${IT_DB_PASS:schema_local_only}",
        "spring.flyway.clean-disabled=false"
})
class SlaBoardIT {

    private static final long T = 882;   // 独立测试租户隔离号段

    @Autowired
    private WebApplicationContext ctx;

    @Autowired
    private JwtCodec jwt;

    @Autowired
    private JdbcTemplate jdbc;

    private MockMvc mvc;
    private long adminId;
    private long outsiderId;

    @BeforeAll
    void setUp() {
        mvc = MockMvcBuilders.webAppContextSetup(ctx)
                .addFilters(ctx.getBeansOfType(jakarta.servlet.Filter.class).values()
                        .toArray(new jakarta.servlet.Filter[0]))
                .build();
        adminId = ensureUser("sla_admin_it");
        outsiderId = ensureUser("sla_outsider_it");
        // org:manage 角色幂等种子（tenant_id=T 隔离段）
        jdbc.update("INSERT INTO sys_role (tenant_id, app_id, code, name, role_type) "
                + "VALUES (" + T + ", 1, 'it_sla_admin', 'IT SLA 管理员', 'APP') "
                + "ON CONFLICT DO NOTHING");
        Long roleId = jdbc.queryForObject(
                "SELECT id FROM sys_role WHERE tenant_id=" + T + " AND code='it_sla_admin'", Long.class);
        jdbc.update("INSERT INTO sys_role_permission (role_id, resource_type, resource_id, action) "
                + "VALUES (?, 'ACTION', 0, 'org:manage') ON CONFLICT DO NOTHING", roleId);
        jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
                adminId, roleId);
    }

    @AfterAll
    void cleanup() {
        jdbc.update("DELETE FROM sla_minute_sample WHERE tenant_id = ?", T);
        jdbc.update("DELETE FROM ops_maintenance_window WHERE tenant_id = ?", T);
        jdbc.update("DELETE FROM sys_user_role WHERE user_id IN (?, ?)", adminId, outsiderId);
        jdbc.update("DELETE FROM sys_role_permission WHERE role_id IN "
                + "(SELECT id FROM sys_role WHERE tenant_id=" + T + ")");
        jdbc.update("DELETE FROM sys_role WHERE tenant_id = " + T);
        jdbc.update("DELETE FROM sys_user WHERE id IN (?, ?)", adminId, outsiderId);
    }

    private long ensureUser(String account) {
        List<Long> existing = jdbc.query(
                "SELECT id FROM sys_user WHERE tenant_id=" + T + " AND account=? LIMIT 1",
                (rs, i) -> rs.getLong(1), account);
        if (!existing.isEmpty()) {
            return existing.get(0);
        }
        var encoder = new org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder();
        jdbc.update("INSERT INTO sys_user (tenant_id, account, name, password_hash, status, "
                        + "must_change_password) VALUES (" + T + ", ?, ?, ?, 'ACTIVE', false)",
                account, account, encoder.encode("SlaIt!2026x"));
        return jdbc.queryForObject("SELECT id FROM sys_user WHERE account=?", Long.class, account);
    }

    /** 该租户 JWT（JwtCodec 绑定 tenantId=T）。 */
    private String access(long userId) {
        return jwt.issueAccess(userId, T);
    }

    /** 造分钟样本：minute 偏移（相对本月 1 日 UTC）。 */
    private void sample(int day, int minuteOfHour, long total, long failed, boolean unreachable) {
        OffsetDateTime minute = OffsetDateTime.now(ZoneOffset.UTC)
                .withDayOfMonth(Math.min(day, 28)).withHour(3).withMinute(minuteOfHour)
                .withSecond(0).withNano(0);
        jdbc.update("INSERT INTO sla_minute_sample (tenant_id, minute, total_req, failed_req, unreachable) "
                        + "VALUES (?,?,?,?,?) ON CONFLICT (tenant_id, minute) DO UPDATE "
                        + "SET total_req=EXCLUDED.total_req, failed_req=EXCLUDED.failed_req, "
                        + "unreachable=EXCLUDED.unreachable",
                T, minute, total, failed, unreachable);
    }

    /** 测试隔离：每个用例先清空本租户样本与窗口（PER_CLASS 共享库状态——不清理会互相污染；
     * 平台级 tenant_id=0 窗口一并清——本测试是唯一造平台级窗口的用例，中途断言失败
     * 会跳过尾部删除留下残留（跨运行累积污染）。 */
    private void cleanSlate() {
        jdbc.update("DELETE FROM sla_minute_sample WHERE tenant_id = ?", T);
        jdbc.update("DELETE FROM ops_maintenance_window WHERE tenant_id = ?", T);
        jdbc.update("DELETE FROM ops_maintenance_window WHERE tenant_id = 0 AND title = 'IT 平台维护'");
    }

    // ---------- 可用性计算闭环 ----------

    @Test
    void 孤立抖动分钟不计入不可用() throws Exception {
        cleanSlate();
        // 单分钟错误率 100%（孤立 1 分钟）——不计入 unavailableMinutes
        sample(10, 0, 100, 100, false);
        mvc.perform(get("/api/ops/sla/monthly")
                        .header("Authorization", "Bearer " + access(adminId)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.unavailableMinutes").value(0))
                .andExpect(jsonPath("$.sampledMinutes").value(1));
    }

    @Test
    void 连续5分钟以上不可用计入() throws Exception {
        cleanSlate();
        // 连续 6 分钟错误率 >5% → 计入 6 不可用分钟 + 1 段故障
        for (int i = 10; i <= 15; i++) {
            sample(12, i, 100, 90, false);
        }
        mvc.perform(get("/api/ops/sla/monthly")
                        .header("Authorization", "Bearer " + access(adminId)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.unavailableMinutes").value(6))
                .andExpect(jsonPath("$.incidents.length()").value(1))
                .andExpect(jsonPath("$.incidents[0].minutes").value(6));
    }

    @Test
    void 维护窗口从分母扣除() throws Exception {
        cleanSlate();
        // 平台级维护窗口 60 分钟（tenant_id=0）→ excludedMaintenanceMinutes=60
        jdbc.update("INSERT INTO ops_maintenance_window "
                + "(tenant_id, title, start_at, end_at, announced_at, status) "
                + "VALUES (0, 'IT 平台维护', now() - interval '2 hours', now() - interval '1 hour', "
                + "now() - interval '80 hours', 'DONE')");
        OffsetDateTime now = OffsetDateTime.now(ZoneOffset.UTC);
        String year = String.valueOf(now.getYear());
        String month = String.valueOf(now.getMonthValue());
        mvc.perform(get("/api/ops/sla/monthly").param("year", year).param("month", month)
                        .header("Authorization", "Bearer " + access(adminId)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.excludedMaintenanceMinutes").value(60))
                // 分母扣除了 60：总分钟 - 60
                .andExpect(jsonPath("$.effectiveMinutes")
                        .value(java.time.YearMonth.of(now.getYear(), now.getMonthValue())
                                .lengthOfMonth() * 24L * 60L - 60));
        jdbc.update("DELETE FROM ops_maintenance_window WHERE tenant_id=0 AND title='IT 平台维护'");
    }

    @Test
    void 零样本可用性为null() throws Exception {
        // 未来月份零样本 → availability=null（前端展示「采样中」）
        mvc.perform(get("/api/ops/sla/monthly").param("year", "2030").param("month", "1")
                        .header("Authorization", "Bearer " + access(adminId)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.availability").doesNotExist());
    }

    // ---------- 维护窗口纪律 ----------

    @Test
    void 维护窗口提前72小时纪律() throws Exception {
        // 不足 72h → 409 MAINT_WINDOW_LEAD_TIME
        mvc.perform(post("/api/ops/sla/maintenance-windows")
                        .header("Authorization", "Bearer " + access(adminId))
                        .contentType("application/json")
                        .content("{\"title\":\"临时维护\",\"startAt\":\""
                                + OffsetDateTime.now().plusHours(24) + "\",\"endAt\":\""
                                + OffsetDateTime.now().plusHours(25) + "\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("MAINT_WINDOW_LEAD_TIME"));
    }

    @Test
    void 维护窗口超2小时被拒() throws Exception {
        mvc.perform(post("/api/ops/sla/maintenance-windows")
                        .header("Authorization", "Bearer " + access(adminId))
                        .contentType("application/json")
                        .content("{\"title\":\"超长维护\",\"startAt\":\""
                                + OffsetDateTime.now().plusHours(120) + "\",\"endAt\":\""
                                + OffsetDateTime.now().plusHours(123) + "\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("MAINT_WINDOW_TOO_LONG"));
    }

    @Test
    void 合规窗口登记成功() throws Exception {
        // 提前 5 天 + 1 小时窗口 → 创建成功
        mvc.perform(post("/api/ops/sla/maintenance-windows")
                        .header("Authorization", "Bearer " + access(adminId))
                        .contentType("application/json")
                        .content("{\"title\":\"IT 合规维护\",\"startAt\":\""
                                + OffsetDateTime.now().plusHours(120) + "\",\"endAt\":\""
                                + OffsetDateTime.now().plusHours(121) + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.created").value(true));
        // 同月第二次计划内窗口被拒（每月 ≤1 次）
        mvc.perform(post("/api/ops/sla/maintenance-windows")
                        .header("Authorization", "Bearer " + access(adminId))
                        .contentType("application/json")
                        .content("{\"title\":\"IT 第二次维护\",\"startAt\":\""
                                + OffsetDateTime.now().plusHours(130) + "\",\"endAt\":\""
                                + OffsetDateTime.now().plusHours(131) + "\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("MAINT_WINDOW_MONTHLY_LIMIT"));
    }

    // ---------- 权限闸 ----------

    @Test
    void 无orgManage权限403() throws Exception {
        mvc.perform(get("/api/ops/sla/monthly")
                        .header("Authorization", "Bearer " + access(outsiderId)))
                .andExpect(status().isForbidden());
        mvc.perform(get("/api/ops/sla/maintenance-windows")
                        .header("Authorization", "Bearer " + access(outsiderId)))
                .andExpect(status().isForbidden());
        mvc.perform(post("/api/ops/sla/maintenance-windows")
                        .header("Authorization", "Bearer " + access(outsiderId))
                        .contentType("application/json")
                        .content("{\"title\":\"x\",\"startAt\":\"2030-01-01T00:00:00Z\","
                                + "\"endAt\":\"2030-01-01T01:00:00Z\"}"))
                .andExpect(status().isForbidden());
    }
}
