package com.schema.bootstrap;

import com.schema.notification.application.NotificationService;
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

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * M10 集成测试（真实 PG，12BE §8 硬性要求）：
 * 渲染占位降级 / 频控 SUPPRESS（同任务二次催办被吞）/ 偏好过滤 /
 * 已读状态机（单条幂等 + 全部已读）/ 未读数 / SECURITY_ALERT 不限频。
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
class NotificationIT {

    private static final long TENANT = 883;
    private static final TenantInfo T = new TenantInfo(TENANT, 1, 1);

    @Autowired
    private NotificationService notify;

    @Autowired
    private JdbcTemplate jdbc;

    @AfterAll
    void cleanup() {
        jdbc.update("DELETE FROM notify_message WHERE tenant_id = ?", TENANT);
        jdbc.update("DELETE FROM notify_user_pref WHERE tenant_id = ?", TENANT);
        jdbc.update("DELETE FROM notify_rate_window WHERE rate_key LIKE 'rate:" + TENANT + ":%'");
        jdbc.update("DELETE FROM notify_template WHERE tenant_id = ?", TENANT);
        jdbc.update("DELETE FROM sys_user WHERE tenant_id = ? AND account LIKE 'it_notify_%'", TENANT);
    }

    @Test
    void 渲染_变量命中与缺失降级() {
        Map<String, Object> resp = notify.send(TENANT, "FLOW_DONE", "BO-1001", 1,
                "FLOW_DONE_APPROVED",
                Map.of("flowName", "报销登记", "bizRef", "BO-1001"), "/flow/BO-1001");
        assertEquals("DONE", resp.get("status"));
        assertFalse(Boolean.TRUE.equals(resp.get("partial")));
    }

    @Test
    void 渲染_缺变量partial降级可用性优先() {
        // bizRef 缺失 → '--' 占位 + partial=true（12BE §3 ③ 消息照发）
        Map<String, Object> resp = notify.send(TENANT, "FLOW_TODO", "BO-1002", 1,
                "FLOW_TODO_APPROVE",
                Map.of("flowName", "请假"), "/flow/BO-1002");
        assertEquals("DONE", resp.get("status"));
        assertEquals(true, resp.get("partial"));
        // 落库快照验证占位符
        Map<String, Object> row = jdbc.queryForMap(
                "SELECT rendered FROM notify_message WHERE tenant_id = ? AND biz_ref_id = 'BO-1002'", TENANT);
        assertTrue(String.valueOf(row.get("rendered")).contains("--"));
    }

    @Test
    void 频控_同一任务二次催办被SUPPRESS() {
        Map<String, Object> first = notify.send(TENANT, "FLOW_URGE", "TASK-777", 1, "FLOW_URGE",
                Map.of("flowName", "报销", "sender", "张三", "bizRef", "TASK-777"), null);
        assertEquals("DONE", first.get("status"));
        // 同任务同收件人 1 小时窗口内第二次 → SUPPRESS（12BE §5）
        Map<String, Object> second = notify.send(TENANT, "FLOW_URGE", "TASK-777", 1, "FLOW_URGE",
                Map.of("flowName", "报销", "sender", "李四", "bizRef", "TASK-777"), null);
        assertEquals("SUPPRESSED", second.get("status"));
        assertEquals("RATE_LIMITED", second.get("reason"));
        // 抑制原因落库可审计（FIX-M10：DB 可区分偏好/用户级/租户级/业务键级）
        Long sid = Long.parseLong(String.valueOf(second.get("id")));
        Map<String, Object> srow = jdbc.queryForMap(
                "SELECT status, suppress_reason FROM notify_message WHERE tenant_id = ? AND id = ?",
                TENANT, sid);
        assertEquals("SUPPRESSED", String.valueOf(srow.get("status")));
        assertEquals("RATE_LIMITED", String.valueOf(srow.get("suppress_reason")));
        // 不同任务不受影响
        Map<String, Object> other = notify.send(TENANT, "FLOW_URGE", "TASK-778", 1, "FLOW_URGE",
                Map.of("flowName", "报销", "sender", "李四", "bizRef", "TASK-778"), null);
        assertEquals("DONE", other.get("status"));
    }

    @Test
    void 频控_SECURITY_ALERT不限频() {
        for (int i = 0; i < 5; i++) {
            Map<String, Object> resp = notify.send(TENANT, "SECURITY_ALERT", "OP-" + i, 1,
                    "SECURITY_SENSITIVE_OP",
                    Map.of("account", "admin", "op", "role_change"), null);
            assertEquals("DONE", resp.get("status"), "第 " + i + " 条安全告警不应被限频");
        }
    }

    @Test
    void 偏好_业务类型关闭后SUPPRESS() {
        jdbc.update("INSERT INTO sys_user (tenant_id, account, status) VALUES (?, 'it_notify_u1', 'ACTIVE') ON CONFLICT DO NOTHING", TENANT);
        Long uid = jdbc.queryForObject(
                "SELECT id FROM sys_user WHERE tenant_id = ? AND account = 'it_notify_u1'", Long.class, TENANT);
        // 关闭 APP_NOTICE（参数绑定写 prefs）
        TenantContext.with(T, () -> {
            jdbc.update("""
                    INSERT INTO notify_user_pref (tenant_id, user_id, prefs)
                    VALUES (?, ?, ?::jsonb)
                    ON CONFLICT (tenant_id, user_id) DO UPDATE SET prefs = EXCLUDED.prefs
                    """, TENANT, uid, "{\"APP_NOTICE\": false}");
            return null;
        });
        Map<String, Object> resp = notify.send(TENANT, "APP_NOTICE", "N-1", uid, "APP_RELEASED",
                Map.of("appName", "CRM", "version", "3"), null);
        assertEquals("SUPPRESSED", resp.get("status"));
        assertEquals("USER_PREF_DISABLED", resp.get("reason"));
    }

    @Test
    void FIX_M10_抑制消息不进列表与未读数() {
        // 用户 5 造 1 条正常（FLOW_TODO）+ 1 条被偏好抑制的 APP_NOTICE
        jdbc.update("INSERT INTO sys_user (tenant_id, account, status) VALUES (?, 'it_notify_u5', 'ACTIVE') ON CONFLICT DO NOTHING", TENANT);
        Long uid = jdbc.queryForObject(
                "SELECT id FROM sys_user WHERE tenant_id = ? AND account = 'it_notify_u5'", Long.class, TENANT);
        TenantContext.with(T, () -> {
            jdbc.update("""
                    INSERT INTO notify_user_pref (tenant_id, user_id, prefs)
                    VALUES (?, ?, ?::jsonb)
                    ON CONFLICT (tenant_id, user_id) DO UPDATE SET prefs = EXCLUDED.prefs
                    """, TENANT, uid, "{\"APP_NOTICE\": false}");
            return null;
        });
        Map<String, Object> ok = notify.send(TENANT, "FLOW_TODO", "N-fix10-ok", uid, "FLOW_TODO_APPROVE",
                Map.of("flowName", "正常", "bizRef", "N-fix10-ok"), null);
        assertEquals("DONE", ok.get("status"));
        Map<String, Object> suppressed = notify.send(TENANT, "APP_NOTICE", "N-fix10-sup", uid, "APP_RELEASED",
                Map.of("appName", "Sup", "version", "1"), null);
        assertEquals("SUPPRESSED", suppressed.get("status"));

        TenantInfo u5 = new TenantInfo(TENANT, 1, uid);
        // 列表不含 SUPPRESSED；total/unread 同步排除
        Map<String, Object> list = TenantContext.with(u5, () -> notify.list(false, null, 0, 50));
        List<?> items = (List<?>) list.get("items");
        assertTrue(items.stream().noneMatch(m ->
                String.valueOf(((Map<?, ?>) m).get("bizRefId")).equals("N-fix10-sup")),
                "SUPPRESSED 消息不得出现在用户列表");
        assertEquals(1L, ((Number) list.get("total")).longValue());
        assertEquals(1L, ((Number) list.get("unread")).longValue());
        // 未读数不含抑制消息
        Map<String, Object> unread = TenantContext.with(u5, () -> notify.unreadCount());
        assertEquals(1L, ((Number) unread.get("unread")).longValue());
        // 全部已读只作用可见集：抑制消息 read_at 保持 NULL（审计原貌）
        TenantContext.with(u5, () -> notify.markAllRead());
        Long supId = Long.parseLong(String.valueOf(suppressed.get("id")));
        OffsetDateTime supReadAt = jdbc.queryForObject(
                "SELECT read_at FROM notify_message WHERE tenant_id = ? AND id = ?", OffsetDateTime.class, TENANT, supId);
        assertNull(supReadAt, "全部已读不得触碰 SUPPRESSED 消息");
        // 单条已读同样拒绝 SUPPRESSED
        TenantContext.with(u5, () -> notify.markRead(supId));
        OffsetDateTime supReadAt2 = jdbc.queryForObject(
                "SELECT read_at FROM notify_message WHERE tenant_id = ? AND id = ?", OffsetDateTime.class, TENANT, supId);
        assertNull(supReadAt2, "单条已读不得标记 SUPPRESSED 消息");
        // 审计可追溯：抑制记录仍在库且带原因
        Map<String, Object> audit = jdbc.queryForMap(
                "SELECT status, suppress_reason FROM notify_message WHERE tenant_id = ? AND id = ?",
                TENANT, supId);
        assertEquals("SUPPRESSED", String.valueOf(audit.get("status")));
        assertEquals("USER_PREF_DISABLED", String.valueOf(audit.get("suppress_reason")));
    }

    @Test
    void FIX_M10_跨bizRef不绕过用户级上限() {
        // CUSTOM 默认窗口 10 条/小时/业务键；用户级兜底 50 条/小时——
        // 同一用户换 60 个 bizRef 发送：前 50 条 DONE，第 51 条起 USER_RATE_LIMITED
        jdbc.update("INSERT INTO sys_user (tenant_id, account, status) VALUES (?, 'it_notify_u6', 'ACTIVE') ON CONFLICT DO NOTHING", TENANT);
        Long uid = jdbc.queryForObject(
                "SELECT id FROM sys_user WHERE tenant_id = ? AND account = 'it_notify_u6'", Long.class, TENANT);
        int done = 0;
        int userLimited = 0;
        for (int i = 0; i < 60; i++) {
            Map<String, Object> resp = notify.send(TENANT, "CUSTOM", "REF-" + i, uid, null, Map.of(), null);
            if ("DONE".equals(resp.get("status")) && "RATE_LIMITED".equals(resp.get("reason"))) {
                // 业务键级不应触发（每键仅 1 次）
                fail("单键一次不应命中业务键级频控");
            }
            if ("DONE".equals(resp.get("status"))) done++;
            if ("USER_RATE_LIMITED".equals(resp.get("reason")) && "SUPPRESSED".equals(resp.get("status"))) userLimited++;
        }
        assertEquals(50, done, "用户级兜底应恰好放行 50 条");
        assertEquals(10, userLimited, "超出用户级上限的 10 条应被 USER_RATE_LIMITED 抑制");
    }

    @Test
    void FIX_M10_租户级护栏跨bizType跨用户合计() {
        // 独立租户隔离护栏计数——不污染同租户其他用例的频控状态
        long gTenant = 884;
        try {
            // 直接把租户窗口计数推到上限：TENANT_GUARD = [3600, 200]
            jdbc.update("INSERT INTO notify_rate_window (rate_key, window_start, count) VALUES (?, now(), 200) "
                    + "ON CONFLICT (rate_key) DO UPDATE SET count = 200, window_start = now()",
                    "rate:" + gTenant + ":tenant");
            // 下一条任意 bizType/收件人 → TENANT_RATE_LIMITED（护栏先于用户级/业务键级判定）
            Map<String, Object> hit = notify.send(gTenant, "FLOW_TODO", "T-guard", 7, "FLOW_TODO_APPROVE",
                    Map.of("flowName", "护栏", "bizRef", "T-guard"), null);
            assertEquals("SUPPRESSED", hit.get("status"));
            assertEquals("TENANT_RATE_LIMITED", hit.get("reason"));
            // SECURITY_ALERT 豁免租户护栏（安全告警宁可重复）
            Map<String, Object> sec = notify.send(gTenant, "SECURITY_ALERT", "T-guard-sec", 7,
                    "SECURITY_SENSITIVE_OP", Map.of("account", "x", "op", "guard"), null);
            assertEquals("DONE", sec.get("status"), "安全告警不受租户护栏限制");
            // 落库原因可审计
            Long hid = Long.parseLong(String.valueOf(hit.get("id")));
            String reason = jdbc.queryForObject(
                    "SELECT suppress_reason FROM notify_message WHERE tenant_id = ? AND id = ?",
                    String.class, gTenant, hid);
            assertEquals("TENANT_RATE_LIMITED", reason);
        } finally {
            jdbc.update("DELETE FROM notify_message WHERE tenant_id = ?", gTenant);
            jdbc.update("DELETE FROM notify_rate_window WHERE rate_key LIKE 'rate:" + gTenant + ":%'");
        }
    }

    @Test
    void 状态机_单条已读幂等与全部已读() {
        // 收件人 2 造 3 条
        for (int i = 0; i < 3; i++) {
            notify.send(TENANT, "APP_NOTICE", "N-batch-" + i, 2, "APP_RELEASED",
                    Map.of("appName", "App" + i, "version", "1"), null);
        }
        jdbc.update("INSERT INTO sys_user (tenant_id, account, status) VALUES (?, 'it_notify_u2', 'ACTIVE') ON CONFLICT DO NOTHING", TENANT);

        Map<String, Object> list0 = TenantContext.with(new TenantInfo(TENANT, 1, 2),
                () -> notify.list(true, null, 0, 10));
        assertEquals(3L, ((Number) list0.get("unread")).longValue());

        // 单条已读（幂等：二次标记不报错不变时点）
        Long firstId = Long.parseLong(String.valueOf(((List<?>) list0.get("items")).isEmpty()
                ? "0" : ((Map<?, ?>) ((List<?>) list0.get("items")).get(0)).get("id")));
        TenantInfo u2 = new TenantInfo(TENANT, 1, 2);
        TenantContext.with(u2, () -> notify.markRead(firstId));
        TenantContext.with(u2, () -> notify.markRead(firstId));   // 幂等重放
        Map<String, Object> afterOne = TenantContext.with(u2, () -> notify.unreadCount());
        assertEquals(2L, ((Number) afterOne.get("unread")).longValue());

        // 全部已读
        Map<String, Object> all = TenantContext.with(u2, () -> notify.markAllRead());
        assertEquals(2, all.get("updated"));
        Map<String, Object> afterAll = TenantContext.with(u2, () -> notify.unreadCount());
        assertEquals(0L, ((Number) afterAll.get("unread")).longValue());
        // 重跑幂等（0 行更新）
        Map<String, Object> again = TenantContext.with(u2, () -> notify.markAllRead());
        assertEquals(0, again.get("updated"));
    }

    @Test
    void 越权_同租户他人消息不可标记已读() {
        // 收件人 1 的消息；同租户用户 2 尝试标记 → 0 行更新（收件人绑定红线）
        Map<String, Object> resp = notify.send(TENANT, "APP_NOTICE", "N-isolate", 1, "APP_RELEASED",
                Map.of("appName", "Isolated", "version", "1"), null);
        assertEquals("DONE", resp.get("status"));
        Long msgId = Long.parseLong(String.valueOf(resp.get("id")));
        TenantInfo attacker = new TenantInfo(TENANT, 1, 2);
        TenantContext.with(attacker, () -> notify.markRead(msgId));   // 收件人绑定：他人标记无效
        Map<String, Object> owner = TenantContext.with(T, () -> notify.list(true, "APP_NOTICE", 0, 50));
        boolean stillUnread = ((List<?>) owner.get("items")).stream()
                .anyMatch(m -> String.valueOf(((Map<?, ?>) m).get("id")).equals(String.valueOf(msgId)));
        assertTrue(stillUnread, "他人标记不应影响收件人未读状态");
    }

    @Test
    void 越权_跨租户消息不可见() {
        // 跨租户查询列表为空（租户隔离过滤）
        Map<String, Object> foreign = TenantContext.with(new TenantInfo(999, 1, 1),
                () -> notify.list(false, null, 0, 10));
        assertEquals(0L, ((Number) foreign.get("total")).longValue());
    }

    @Test
    void 模板_租户自定义覆盖系统内置() {
        jdbc.update("""
                INSERT INTO notify_template (tenant_id, key, title, body, vars_schema)
                VALUES (?, 'FLOW_TODO_APPROVE', '租户版待办：{{flowName}}', '自定义正文 {{bizRef}}', NULL)
                ON CONFLICT (tenant_id, key) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body
                """, TENANT);
        Map<String, Object> resp = notify.send(TENANT, "FLOW_TODO", "BO-custom", 3,
                "FLOW_TODO_APPROVE",
                Map.of("flowName", "自定义流程", "bizRef", "BO-custom"), null);
        assertEquals("DONE", resp.get("status"));
        Map<String, Object> row = jdbc.queryForMap("""
                SELECT rendered FROM notify_message
                WHERE tenant_id = ? AND biz_ref_id = 'BO-custom'
                """, TENANT);
        assertTrue(String.valueOf(row.get("rendered")).contains("租户版待办"));
        assertNotNull(row.get("rendered"));
    }
}
