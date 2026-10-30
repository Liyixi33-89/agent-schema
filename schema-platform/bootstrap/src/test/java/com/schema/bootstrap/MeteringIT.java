package com.schema.bootstrap;

import com.schema.metering.application.MeteringEventService;
import com.schema.metering.infrastructure.seats.LicensedSeatCalculator;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;

import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * M8 集成测试（真实 PG，09BE §9 硬性要求）：
 * 幂等（同 eventId 只计一次）/ 聚合覆盖写重跑安全 / 时间归属 /
 * seat 口径（服务端终审去重 + 双源只信服务端）/ 授权席位判定与每日快照 /
 * summary 双字段口径并排。
 * 前置：docker compose up -d postgres。
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
class MeteringIT {

    private static final TenantInfo T1 = new TenantInfo(1, 1, 1);

    @Autowired
    private MeteringEventService metering;

    @Autowired
    private LicensedSeatCalculator seats;

    @Autowired
    private JdbcTemplate jdbc;

    @AfterAll
    void cleanup() {
        jdbc.update("DELETE FROM usage_event WHERE tenant_id = 881");
        jdbc.update("DELETE FROM usage_daily WHERE tenant_id = 881");
        jdbc.update("DELETE FROM seat_license_daily WHERE tenant_id = 881");
    }

    private Map<String, Object> envelope(String metric, String eventId, Map<String, Object> attrs) {
        Map<String, Object> env = new LinkedHashMap<>();
        env.put("eventId", eventId);
        env.put("metric", metric);
        env.put("occurredAt", java.time.OffsetDateTime.now().toString());
        if (attrs != null) {
            env.put("attrs", attrs);
        }
        return env;
    }

    @Test
    void 幂等_同eventId重投递只计一次() {
        TenantContext.with(T1, () -> {
            String eventId = UUID.randomUUID().toString();
            List<Integer> r1 = metering.ingest(881, 1L, List.of(envelope("seat.active", eventId,
                    Map.of("surface", "designer"))));
            List<Integer> r2 = metering.ingest(881, 1L, List.of(envelope("seat.active", eventId,
                    Map.of("surface", "designer"))));
            assertTrue(r1 == null && r2 == null);
            Long n = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM usage_event WHERE event_id = ?", Long.class, eventId);
            assertEquals(1L, n);
            return null;
        });
    }

    @Test
    void 防伪造_客户端通道终审指标被拒() {
        TenantContext.with(T1, () -> {
            // ai.tokens / build.count / api.calls 均为服务端终审指标——客户端通道整批 422
            List<Integer> r = metering.ingest(881, 1L, List.of(
                    envelope("ai.tokens.in", UUID.randomUUID().toString(), null),
                    envelope("build.count", UUID.randomUUID().toString(), null)));
            assertNotNull(r);
            assertEquals(List.of(0, 1), r);
            return null;
        });
    }

    @Test
    void 防伪造_source客户端声明不作数() {
        TenantContext.with(T1, () -> {
            // 信封声称 source=SERVER 也强制归 CLIENT（服务端终审只走 recordServer 内部入口）
            Map<String, Object> env = envelope("seat.active", UUID.randomUUID().toString(),
                    Map.of("surface", "designer"));
            env.put("source", "SERVER");
            List<Integer> r = metering.ingest(881, 1L, List.of(env));
            assertTrue(r == null);
            Long serverRows = jdbc.queryForObject("""
                    SELECT COUNT(*) FROM usage_event
                    WHERE tenant_id = 881 AND metric = 'seat.active' AND source = 'SERVER'
                      AND occurred_at::date = CURRENT_DATE AND user_id = 999
                    """, Long.class);
            assertEquals(0L, serverRows);
            return null;
        });
    }

    @Test
    void 漏斗指标_客户端通道正常受理() {
        TenantContext.with(T1, () -> {
            List<Integer> r = metering.ingest(881, 1L, List.of(
                    envelope("funnel.ai.invoke", UUID.randomUUID().toString(), Map.of("feature", "ai_panel")),
                    envelope("funnel.artifact.load", UUID.randomUUID().toString(),
                            Map.of("pageId", 42, "hash", "abc123"))));
            assertTrue(r == null);
            return null;
        });
    }

    @Test
    void 合规_业务字段值整批拒绝并返回违规下标() {
        TenantContext.with(T1, () -> {
            Map<String, Object> bad = envelope("seat.active", UUID.randomUUID().toString(),
                    Map.of("formValue", "手机号"));
            List<Integer> invalid = metering.ingest(881, 1L, List.of(bad));
            assertNotNull(invalid);
            assertEquals(List.of(0), invalid);
            return null;
        });
    }

    @Test
    void 时间归属_伪造25h前occurredAt按receivedAt落日() {
        // flow.exec 为终审指标（客户端通道被拒）——时间归属经域归一化直接验证
        TenantContext.with(T1, () -> {
            Map<String, Object> env = envelope("seat.active", UUID.randomUUID().toString(),
                    Map.of("surface", "designer"));
            env.put("occurredAt", java.time.OffsetDateTime.now().minusHours(25).toString());
            List<Integer> r = metering.ingest(881, 1L, List.of(env));
            assertTrue(r == null);
            Long mismatch = jdbc.queryForObject("""
                    SELECT COUNT(*) FROM usage_event
                    WHERE tenant_id = 881 AND metric = 'seat.active'
                      AND occurred_at::date <> received_at::date
                    """, Long.class);
            assertEquals(0L, mismatch);
            return null;
        });
    }

    @Test
    void 时间归属_未来时间按receivedAt归属() {
        // occurredAt 晚于接收时刻（预落未来日期逃当期配额）→ 强制 received_at 归属
        TenantContext.with(T1, () -> {
            Map<String, Object> env = envelope("seat.active", UUID.randomUUID().toString(),
                    Map.of("surface", "designer"));
            env.put("occurredAt", java.time.OffsetDateTime.now().plusDays(3).toString());
            List<Integer> r = metering.ingest(881, 1L, List.of(env));
            assertTrue(r == null);
            Long future = jdbc.queryForObject("""
                    SELECT COUNT(*) FROM usage_event
                    WHERE tenant_id = 881 AND occurred_at > received_at
                    """, Long.class);
            assertEquals(0L, future);
            return null;
        });
    }

    @Test
    void seat口径_服务端终审去重且双源只信服务端() {
        TenantContext.with(T1, () -> {
            String day = LocalDate.now().toString();
            // 同一用户（userId=77）前端漏斗 3 条 + 服务端终审 1 条
            for (int i = 0; i < 3; i++) {
                metering.ingest(881, 77L, List.of(envelope("seat.active", UUID.randomUUID().toString(),
                        Map.of("surface", "designer"))));
            }
            metering.recordServer(881, 77L, "seat.active", 1L, null, "{\"surface\":\"designer\"}");
            // 另一用户仅服务端
            metering.recordServer(881, 78L, "seat.active", 1L, null, "{\"surface\":\"designer\"}");

            metering.aggregate(LocalDate.now());
            Long qty = jdbc.queryForObject("""
                    SELECT quantity FROM usage_daily
                    WHERE tenant_id = 881 AND metric = 'seat.active' AND stat_date = ?::date
                    """, Long.class, day);
            // 只信服务端去重：77/78 两人（前端 3 条不放大）
            assertEquals(2L, qty);

            // 滚动 30 天活跃口径同样只含服务端
            assertEquals(2L, metering.summary(881, LocalDate.now()).get("activeSeats"));
            return null;
        });
    }

    @Test
    void 聚合_覆盖写重跑结果不变() {
        TenantContext.with(T1, () -> {
            metering.recordServer(881, 1L, "api.calls", 5L, null, null);
            LocalDate day = LocalDate.now();
            metering.aggregate(day);
            Long q1 = jdbc.queryForObject("""
                    SELECT quantity FROM usage_daily
                    WHERE tenant_id = 881 AND metric = 'api.calls' AND stat_date = ?::date
                    """, Long.class, day);
            metering.aggregate(day);
            Long q2 = jdbc.queryForObject("""
                    SELECT quantity FROM usage_daily
                    WHERE tenant_id = 881 AND metric = 'api.calls' AND stat_date = ?::date
                    """, Long.class, day);
            assertEquals(q1, q2);
            assertTrue(q1 >= 5L);
            return null;
        });
    }

    @Test
    void 授权席位_设计能力角色判定与每日快照() {
        // 造角色与用户（tenant 881）：app_admin（设计能力）与普通角色各一
        jdbc.update("INSERT INTO sys_role (tenant_id, app_id, code, name, role_type) VALUES (881, 1, 'app_admin', 'IT应用管理员', 'APP') ON CONFLICT DO NOTHING");
        jdbc.update("INSERT INTO sys_role (tenant_id, app_id, code, name, role_type) VALUES (881, 1, 'it_viewer', 'IT只读', 'APP') ON CONFLICT DO NOTHING");
        Long adminRole = jdbc.queryForObject("SELECT id FROM sys_role WHERE tenant_id=881 AND code='app_admin' AND role_type='APP'", Long.class);
        Long viewerRole = jdbc.queryForObject("SELECT id FROM sys_role WHERE tenant_id=881 AND code='it_viewer'", Long.class);
        jdbc.update("INSERT INTO sys_user (tenant_id, account, status) VALUES (881, 'it_seat_a', 'ACTIVE') ON CONFLICT DO NOTHING");
        jdbc.update("INSERT INTO sys_user (tenant_id, account, status) VALUES (881, 'it_seat_b', 'ACTIVE') ON CONFLICT DO NOTHING");
        Long userA = jdbc.queryForObject("SELECT id FROM sys_user WHERE tenant_id=881 AND account='it_seat_a'", Long.class);
        Long userB = jdbc.queryForObject("SELECT id FROM sys_user WHERE tenant_id=881 AND account='it_seat_b'", Long.class);
        jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?) ON CONFLICT DO NOTHING", userA, adminRole);
        jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?) ON CONFLICT DO NOTHING", userB, viewerRole);

        try {
            // 授权即计：A 持设计能力角色计入；B 只读不计；A 无任何操作仍计
            assertEquals(1L, seats.licensedSeats(881));
            // 每日快照落库 + 重跑幂等
            seats.snapshot(881, LocalDate.now());
            seats.snapshot(881, LocalDate.now());
            Long snap = jdbc.queryForObject("""
                    SELECT licensed_seats FROM seat_license_daily
                    WHERE tenant_id = 881 AND stat_date = ?::date
                    """, Long.class, LocalDate.now());
            assertEquals(1L, snap);
            // summary 双字段并排：授权口径来自快照、活跃口径来自明细重算
            Map<String, Object> s = metering.summary(881, LocalDate.now());
            assertEquals(1L, ((Number) s.get("licensedSeats")).longValue());
        } finally {
            jdbc.update("DELETE FROM sys_user_role WHERE role_id IN (?, ?)", adminRole, viewerRole);
            jdbc.update("DELETE FROM sys_role WHERE tenant_id = 881 AND code IN ('app_admin','it_viewer')");
            jdbc.update("DELETE FROM sys_user WHERE tenant_id = 881 AND account IN ('it_seat_a','it_seat_b')");
        }
    }

    // ===== FIX-M8 席位并发验收（2026-10-30）：限流生效 / 并发不超限 / 成员变更即时重算 =====

    /** 并发验收专用隔离租户。 */
    private static final long CONC_TENANT = 883;

    @Autowired
    private com.schema.iam.application.AuthService auth;

    /** 临时改写席位上限（测试隔离——原值恢复由调用方负责）。 */
    private void setSeatLimit(long limit) throws Exception {
        java.lang.reflect.Field f = LicensedSeatCalculator.class.getDeclaredField("seatLimit");
        f.setAccessible(true);
        f.setLong(seats, limit);
    }

    /** 并发构造隔离租户角色/用户（每次调用重置状态）。 */
    private Long[] setupConcFixtures(int userCount) {
        jdbc.update("DELETE FROM sys_user_role WHERE user_id IN (SELECT id FROM sys_user WHERE tenant_id=" + CONC_TENANT + ")");
        jdbc.update("DELETE FROM sys_user WHERE tenant_id = " + CONC_TENANT);
        jdbc.update("DELETE FROM sys_role WHERE tenant_id = " + CONC_TENANT);
        jdbc.update("DELETE FROM seat_license_daily WHERE tenant_id = " + CONC_TENANT);
        jdbc.update("INSERT INTO sys_role (tenant_id, app_id, code, name, role_type) VALUES (" + CONC_TENANT
                + ", 1, 'app_admin', 'IT并发管理员', 'APP') ON CONFLICT DO NOTHING");
        jdbc.update("INSERT INTO sys_role (tenant_id, app_id, code, name, role_type) VALUES (" + CONC_TENANT
                + ", 2, 'developer', 'IT并发开发者', 'APP') ON CONFLICT DO NOTHING");
        Long devRoleApp2 = jdbc.queryForObject(
                "SELECT id FROM sys_role WHERE tenant_id=" + CONC_TENANT + " AND code='developer'", Long.class);
        Long adminRoleApp1 = jdbc.queryForObject(
                "SELECT id FROM sys_role WHERE tenant_id=" + CONC_TENANT + " AND code='app_admin'", Long.class);
        for (int i = 0; i < userCount; i++) {
            jdbc.update("INSERT INTO sys_user (tenant_id, account, status) VALUES (" + CONC_TENANT
                    + ", 'it_conc_" + i + "', 'ACTIVE')");
        }
        return new Long[]{adminRoleApp1, devRoleApp2};
    }

    private List<Long> concUsers(int count) {
        return jdbc.queryForList(
                "SELECT id FROM sys_user WHERE tenant_id=" + CONC_TENANT + " ORDER BY id LIMIT " + count, Long.class);
    }

    @Test
    void 席位限流_超限授权被拒且角色不落库() throws Exception {
        long originalLimit = 0;
        java.lang.reflect.Field f = LicensedSeatCalculator.class.getDeclaredField("seatLimit");
        f.setAccessible(true);
        originalLimit = f.getLong(seats);
        setSeatLimit(1);
        try {
            setupConcFixtures(2);
            List<Long> users = concUsers(2);
            Long[] roles = setupConcFixtures(2);
            Long devRole = roles[1];
            // 直接写 A 的设计角色（绕过 grantRoles——基线席位 1）
            jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", users.get(0), devRole);
            try {
                com.schema.platform.common.web.BizException e = org.junit.jupiter.api.Assertions.assertThrows(
                        com.schema.platform.common.web.BizException.class,
                        () -> seats.assertGrantAllowed(CONC_TENANT, List.of(users.get(1))));
                assertEquals("SEAT_LIMIT_EXCEEDED", e.code());
                // 拒绝后 B 无任何角色落库
                Long bRoles = jdbc.queryForObject(
                        "SELECT COUNT(*) FROM sys_user_role WHERE user_id = ?", Long.class, users.get(1));
                assertEquals(0L, bRoles);
            } finally {
                jdbc.update("DELETE FROM sys_user_role WHERE user_id IN (?, ?)", users.get(0), users.get(1));
            }
        } finally {
            setSeatLimit(originalLimit);
        }
    }

    @Test
    void 席位并发_多线程同时授权不突破上限() throws Exception {
        java.lang.reflect.Field f = LicensedSeatCalculator.class.getDeclaredField("seatLimit");
        f.setAccessible(true);
        long originalLimit = f.getLong(seats);
        setSeatLimit(2);
        try {
            setupConcFixtures(5);
            List<Long> users = concUsers(5);
            Long[] roles = setupConcFixtures(5);
            Long devRole = roles[1];
            java.util.concurrent.atomic.AtomicInteger granted = new java.util.concurrent.atomic.AtomicInteger();
            java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(5);
            // 与真实 grantRoles 同构：校验+写入同事务（校验独占锁释放后写入会放行超限）
            org.springframework.transaction.support.TransactionTemplate tx =
                    new org.springframework.transaction.support.TransactionTemplate(
                            new org.springframework.jdbc.datasource.DataSourceTransactionManager(
                                    jdbc.getDataSource()));
            try {
                java.util.List<java.util.concurrent.Future<?>> futures = new java.util.ArrayList<>();
                for (Long uid : users) {
                    futures.add(pool.submit(() -> {
                        try {
                            tx.executeWithoutResult(status -> {
                                seats.assertGrantAllowed(CONC_TENANT, List.of(uid));
                                jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?) "
                                        + "ON CONFLICT DO NOTHING", uid, devRole);
                            });
                            granted.incrementAndGet();
                        } catch (com.schema.platform.common.web.BizException e) {
                            if (!"SEAT_LIMIT_EXCEEDED".equals(e.code())) {
                                throw e;
                            }
                        }
                        return null;
                    }));
                }
                for (java.util.concurrent.Future<?> fut : futures) {
                    fut.get();
                }
            } finally {
                pool.shutdown();
            }
            try {
                assertEquals(2, granted.get());
                assertEquals(2L, seats.licensedSeats(CONC_TENANT));
            } finally {
                jdbc.update("DELETE FROM sys_user_role WHERE user_id IN (" + users.stream()
                        .map(String::valueOf).collect(java.util.stream.Collectors.joining(",")) + ")");
            }
        } finally {
            setSeatLimit(originalLimit);
        }
    }

    @Test
    void 成员变更_授权后即时快照重算() {
        setupConcFixtures(1);
        List<Long> users = concUsers(1);
        Long[] roles = setupConcFixtures(1);
        try {
            // 即时重算入口：onSeatChanged 同步刷新当日快照
            jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)",
                    users.get(0), roles[1]);
            seats.onSeatChanged(CONC_TENANT);
            Long snap = jdbc.queryForObject("""
                    SELECT licensed_seats FROM seat_license_daily
                    WHERE tenant_id = ? AND stat_date = CURRENT_DATE
                    """, Long.class, CONC_TENANT);
            assertEquals(1L, snap);
        } finally {
            jdbc.update("DELETE FROM sys_user_role WHERE user_id = ?", users.get(0));
            jdbc.update("DELETE FROM seat_license_daily WHERE tenant_id = " + CONC_TENANT);
        }
    }

    @Test
    void 快照兜底_角色全部撤销租户写零值() {
        // 历史持席位租户（快照表有记录）当前无角色 → 快照必须归零而非残留旧值
        setupConcFixtures(1);
        Long[] roles = setupConcFixtures(1);
        List<Long> users = concUsers(1);
        jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", users.get(0), roles[1]);
        seats.snapshot(CONC_TENANT, LocalDate.now());
        assertEquals(1L, seats.licensedSeats(CONC_TENANT));
        // 撤销全部角色
        jdbc.update("DELETE FROM sys_user_role WHERE user_id = ?", users.get(0));
        com.schema.metering.application.MeteringSchedule schedule =
                new com.schema.metering.application.MeteringSchedule(metering, seats, jdbc);
        schedule.snapshotAllTenants(LocalDate.now());
        Long snap = jdbc.queryForObject("""
                SELECT licensed_seats FROM seat_license_daily
                WHERE tenant_id = ? AND stat_date = CURRENT_DATE
                """, Long.class, CONC_TENANT);
        assertEquals(0L, snap);
        jdbc.update("DELETE FROM seat_license_daily WHERE tenant_id = " + CONC_TENANT);
    }
}
