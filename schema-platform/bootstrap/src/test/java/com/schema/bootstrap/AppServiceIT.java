package com.schema.bootstrap;

import com.schema.app.application.AppService;
import com.schema.iam.application.AppRoleService;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * M11 集成测试（真 PG，13BE §7 硬性要求——应用域子集）：
 * 应用 CRUD / 导航并发 409 / 成员规则（最后管理员保护、跨租户用户拒绝）/ 越权拦截 / 配额。
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
class AppServiceIT {

    @Autowired
    private AppService apps;

    @Autowired
    private AppRoleService appRoles;

    @Autowired
    private JdbcTemplate jdbc;

    private long appId;

    @BeforeAll
    void warmup() {
        // 幂等清理历史数据（app 域自引用清空——角色/用户行保留供其他 IT 复用）
        jdbc.update("DELETE FROM ops_notice");
        jdbc.update("DELETE FROM app");
        ensureUser(1, "app_default_op", "应用默认操作员");
        ensureUser(2, "app_second_user", "应用第二用户");
        ensureUser(9001, "app_other_tenant", "跨租户用户");
        jdbc.update("DELETE FROM sys_user_role WHERE user_id IN (1,2) AND role_id IN "
                + "(SELECT id FROM sys_role WHERE app_id IS NOT NULL)");
        jdbc.update("DELETE FROM sys_role WHERE app_id IS NOT NULL");
        // 应用创建权限闸（PRD07 §4：租户管理员）：用户 1 需持租户级 org:manage 角色
        jdbc.update("INSERT INTO sys_role (tenant_id, app_id, code, name, role_type) "
                + "VALUES (1, 1, 'it_org_admin', 'IT 组织管理员', 'APP') "
                + "ON CONFLICT DO NOTHING");
        Long roleId = jdbc.queryForObject(
                "SELECT id FROM sys_role WHERE tenant_id=1 AND code='it_org_admin'", Long.class);
        jdbc.update("INSERT INTO sys_role_permission (role_id, resource_type, resource_id, action) "
                + "VALUES (?, 'ACTION', 0, 'org:manage') ON CONFLICT DO NOTHING", roleId);
        jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (1, ?) "
                + "ON CONFLICT DO NOTHING", roleId);
    }

    /** 建号 helper（幂等）。 */
    private void ensureUser(long id, String account, String name) {
        List<Long> exists = jdbc.query(
                "SELECT id FROM sys_user WHERE id=?", (rs, i) -> rs.getLong(1), id);
        if (exists.isEmpty()) {
            var encoder = new org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder();
            jdbc.update("INSERT INTO sys_user (id, tenant_id, account, name, password_hash, status, "
                            + "must_change_password) VALUES (?, ?, ?, ?, ?, 'ACTIVE', false)",
                    id, id == 9001 ? 2 : 1, account, name, encoder.encode("AppOp!2026x"));
        }
    }

    @BeforeEach
    void setUp() {
        TenantContext.clear();
        long stamp = System.nanoTime();
        Map<String, Object> created = apps.create("应用_" + stamp, null, "IT 测试应用", null, "127.0.0.1", "test-ua");
        appId = ((Number) created.get("appId")).longValue();
    }

    @AfterEach
    void cleanup() {
        TenantContext.clear();
    }


    /** TenantContext.with 的 void 包装（with 只收 Supplier）。 */
    private void with(TenantInfo t, Runnable action) {
        TenantContext.with(t, () -> {
            action.run();
            return null;
        });
    }

    /** TenantContext.with 的 void 包装（异常透传版——assertThrows 用）。 */
    private void withThrowing(TenantInfo t, Runnable action) {
        with(t, action);
    }

    private TenantInfo t() {
        return new TenantInfo(1, appId, 1);
    }

    // ---------- 生命周期 ----------

    @Test
    void createInitializesRolesAndGrantsCreatorAdmin() {
        // 三个默认角色就位
        List<String> codes = jdbc.query(
                "SELECT code FROM sys_role WHERE tenant_id=1 AND app_id=? ORDER BY code",
                (rs, i) -> rs.getString(1), appId);
        assertEquals(List.of("app_admin", "developer", "user"), codes);
        // 创建者自动成为应用管理员
        List<String> my = TenantContext.with(t(), () -> appRoles.myRoleCodes(1, appId, 1));
        assertTrue(my.contains("app_admin"), "创建者应为应用管理员: " + my);
    }

    @Test
    void duplicateNameRejected() {
        String name = jdbc.queryForObject("SELECT name FROM app WHERE id=?", String.class, appId);
        BizException e = assertThrows(BizException.class,
                () -> apps.create(name, null, null, null, "127.0.0.1", "ua"));
        assertEquals("APP_NAME_DUPLICATED", e.code());
    }

    @Test
    void crossTenantAccessRejected() {
        // 租户 2 操作租户 1 的应用 → 同判不存在
        TenantInfo other = new TenantInfo(2, appId, 9001);
        BizException e = assertThrows(BizException.class,
                () -> TenantContext.with(other, () -> apps.detail(appId)));
        assertEquals("APP_NOT_FOUND", e.code());
    }

    // ---------- 同租户越权（应用级权限闸） ----------

    @Test
    void nonMemberSameTenantDeniedOnAllAppEndpoints() {
        // 用户 2（本租户、无该应用任何角色）直连接口 → 全链 PERM_DENIED
        TenantInfo outsider = new TenantInfo(1, appId, 2);
        assertPermDenied(outsider, () -> apps.detail(appId));
        assertPermDenied(outsider, () -> apps.update(appId, "越权改名", null, null, null));
        assertPermDenied(outsider, () -> apps.archive(appId, "ip", "ua"));
        assertPermDenied(outsider, () -> apps.restore(appId, "ip", "ua"));
        assertPermDenied(outsider, () -> apps.deletePrecheck(appId));
        assertPermDenied(outsider, () -> apps.delete(appId, "任意名", "ip", "ua"));
        assertPermDenied(outsider, () -> apps.saveNav(appId, List.of(), 1));
        assertPermDenied(outsider, () -> apps.getNav(appId, false));
        assertPermDenied(outsider, () -> appRoles.addMember(1, appId, 2, List.of("user"), 2L, "ip", "ua"));
        assertPermDenied(outsider, () -> appRoles.updateMemberRoles(1, appId, 1, List.of("user"), 2L, "ip", "ua"));
        assertPermDenied(outsider, () -> appRoles.removeMember(1, appId, 1, 2L, "ip", "ua"));
        // 成员列表读面鉴权在 HTTP 层（AppController.members 走 requireAppAdmin）——服务层保持纯查询供内部复用，
        // HTTP 越权断言见 AppHttpSecurityIT
        // 普通成员（仅 user 角色）也不可管理
        with(t(), () -> appRoles.addMember(1, appId, 2, List.of("user"), 1L, "ip", "ua"));
        assertPermDenied(outsider, () -> apps.archive(appId, "ip", "ua"));
        assertPermDenied(outsider, () -> appRoles.removeMember(1, appId, 1, 2L, "ip", "ua"));
    }

    /** 断言 PERM_DENIED（统一辅助）。 */
    private void assertPermDenied(TenantInfo t, Runnable action) {
        BizException e = assertThrows(BizException.class, () -> TenantContext.with(t, () -> {
            action.run();
            return null;
        }));
        assertEquals("PERM_DENIED", e.code(), "预期应用级权限闸拦截");
    }

    @Test
    void archiveAndRestoreLifecycle() {
        with(t(), () -> apps.archive(appId, "ip", "ua"));
        assertEquals("ARCHIVED", TenantContext.with(t(), () ->
                ((String) apps.detail(appId).get("status"))));
        // 归档态不可编辑导航
        BizException nav = assertThrows(BizException.class, () -> TenantContext.with(t(),
                () -> apps.saveNav(appId, List.of(), 1)));
        assertEquals("APP_NOT_EDITABLE", nav.code());
        with(t(), () -> apps.restore(appId, "ip", "ua"));
        assertEquals("ACTIVE", TenantContext.with(t(), () ->
                ((String) apps.detail(appId).get("status"))));
    }

    @Test
    void deleteRequiresConfirmValueAndAudits() {
        // 无 confirmValue → 拒绝（高摩擦确认）
        BizException e = assertThrows(BizException.class, () -> TenantContext.with(t(),
                () -> apps.delete(appId, null, "ip", "ua")));
        assertEquals("APP_DELETE_CONFIRM_REQUIRED", e.code());
        // 错误应用名 → 拒绝
        BizException e2 = assertThrows(BizException.class, () -> TenantContext.with(t(),
                () -> apps.delete(appId, "错误名称", "ip", "ua")));
        assertEquals("APP_DELETE_CONFIRM_REQUIRED", e2.code());
        // precheck 返回影响面 + 确认要求
        Map<String, Object> pre = TenantContext.with(t(), () -> apps.deletePrecheck(appId));
        assertEquals("name", pre.get("confirmField"));
        assertNotNull(((Map<?, ?>) pre.get("impact")).get("appName"));
        // 正确应用名 → 删除成功 + 审计落库
        String name = jdbc.queryForObject("SELECT name FROM app WHERE id=?", String.class, appId);
        Map<String, Object> resp = TenantContext.with(t(), () -> apps.delete(appId, name, "ip", "ua"));
        assertNotNull(resp.get("impact"));
        assertEquals("DELETING", jdbc.queryForObject(
                "SELECT status FROM app WHERE id=?", String.class, appId));
        Integer audits = jdbc.queryForObject(
                "SELECT COUNT(*) FROM sys_audit_log WHERE event_type='PERM_CHANGE' "
                        + "AND resource_type='APP' AND resource_id=? "
                        + "AND diff ->> 'action' = 'APP_DELETE'",
                Integer.class, String.valueOf(appId));
        assertTrue(audits != null && audits >= 1, "删除须记审计 APP_DELETE");
    }

    // ---------- 导航并发与校验 ----------

    @Test
    void navOptimisticConcurrencyConflict() {
        List<Object> tree = List.of(Map.of("id", "m1", "type", "LINK", "label", "帮助", "url", "https://x.dev"));
        Map<String, Object> saved = TenantContext.with(t(), () -> apps.saveNav(appId, tree, 1));
        assertEquals(2, ((Number) saved.get("version")).intValue());
        // 过期 baseVersion 提交 → 领域层先拦（NavVersionConflictException，接口层映射 409 NAV_VERSION_CONFLICT）
        assertThrows(com.schema.app.domain.model.NavVersionConflictException.class,
                () -> TenantContext.with(t(), () -> apps.saveNav(appId, tree, 1)));
    }

    @Test
    void navPageRefMustBelongToApp() {
        // 引用不存在页面 → 拒绝
        List<Object> bad = List.of(Map.of("id", "m1", "type", "PAGE", "label", "幽灵页", "refId", 999999999L));
        BizException e = assertThrows(BizException.class, () -> TenantContext.with(t(),
                () -> apps.saveNav(appId, bad, 1)));
        assertEquals("NAV_PAGE_NOT_FOUND", e.code());
    }

    @Test
    void navStructureValidation() {
        // 非法 type
        IllegalArgumentException e1 = assertThrows(IllegalArgumentException.class, () -> TenantContext.with(t(),
                () -> apps.saveNav(appId, List.of(Map.of("id", "x", "type", "BAD", "label", "x")), 1)));
        // 空 GROUP
        IllegalArgumentException e2 = assertThrows(IllegalArgumentException.class, () -> TenantContext.with(t(),
                () -> apps.saveNav(appId, List.of(Map.of("id", "g", "type", "GROUP", "label", "g", "children", List.of())), 1)));
        // LINK 缺 url
        IllegalArgumentException e3 = assertThrows(IllegalArgumentException.class, () -> TenantContext.with(t(),
                () -> apps.saveNav(appId, List.of(Map.of("id", "l", "type", "LINK", "label", "l")), 1)));
        assertNotNull(e1);
        assertNotNull(e2);
        assertNotNull(e3);
    }

    @Test
    void navNodeIdMustBeGloballyUnique() {
        // 重复 id → 拒绝（防路由歧义/渲染 key 冲突）
        List<Object> dup = List.of(
                Map.of("id", "dup", "type", "LINK", "label", "a", "url", "https://a.dev"),
                Map.of("id", "dup", "type", "LINK", "label", "b", "url", "https://b.dev"));
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> TenantContext.with(t(),
                () -> apps.saveNav(appId, dup, 1)));
        assertTrue(e.getMessage().contains("唯一"));
        // 嵌套重复同理
        List<Object> nested = List.of(Map.of("id", "g", "type", "GROUP", "label", "g",
                "children", List.of(Map.of("id", "g", "type", "LINK", "label", "x", "url", "https://x.dev"))));
        assertThrows(IllegalArgumentException.class, () -> TenantContext.with(t(),
                () -> apps.saveNav(appId, nested, 1)));
    }

    @Test
    void navLinkUrlSchemeRestricted() {
        // javascript: 注入向量 → 拒绝（运行时直出 <a href>）
        List<Object> xss = List.of(Map.of("id", "m1", "type", "LINK", "label", "注入",
                "url", "javascript:alert(1)"));
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> TenantContext.with(t(),
                () -> apps.saveNav(appId, xss, 1)));
        assertTrue(e.getMessage().contains("http"));
    }

    // ---------- 成员规则 ----------

    @Test
    void lastAdminCannotBeRemoved() {
        // 创建者是唯一管理员（setUp 创建时自动授权）
        BizException e = assertThrows(BizException.class, () ->
                withThrowing(t(), () -> appRoles.removeMember(1, appId, 1, 1L, "127.0.0.1", "ua")));
        assertEquals("APP_ADMIN_REQUIRED", e.code());
    }

    @Test
    void crossTenantMemberRejected() {
        // 用户 9001 属租户 2 → 添加被拒（同判不存在）
        BizException e = assertThrows(BizException.class, () ->
                withThrowing(t(), () -> appRoles.addMember(1, appId, 9001, List.of("user"), 1L, "127.0.0.1", "ua")));
        assertEquals("USER_NOT_FOUND", e.code());
    }

    @Test
    void memberAddUpdateRemoveFlow() {
        // 添加第二用户为 developer
        with(t(), () -> appRoles.addMember(1, appId, 2, List.of("developer"), 1L, "ip", "ua"));
        List<Map<String, Object>> members = TenantContext.with(t(), () -> appRoles.listMembers(1, appId));
        assertEquals(2, members.size());
        // 变更为 user
        with(t(), () -> appRoles.updateMemberRoles(1, appId, 2, List.of("user"), 1L, "ip", "ua"));
        List<String> rolesOf2 = TenantContext.with(t(), () -> appRoles.myRoleCodes(1, appId, 2));
        assertEquals(List.of("user"), rolesOf2);
        // 移除（非管理员可移除）
        with(t(), () -> appRoles.removeMember(1, appId, 2, 1L, "ip", "ua"));
        assertTrue(TenantContext.with(t(), () -> appRoles.myRoleCodes(1, appId, 2)).isEmpty());
    }

    @Test
    void unknownRoleCodeRejected() {
        BizException e = assertThrows(BizException.class, () ->
                withThrowing(t(), () -> appRoles.addMember(1, appId, 2, List.of("ghost_role"), 1L, "ip", "ua")));
        assertEquals("ROLE_NOT_FOUND", e.code());
    }

    @Test
    void concurrentRemovalOfLastTwoAdminsLeavesOne() throws Exception {
        // 两个管理员并发互相移除 → 行锁串行化：恰一个成功、应用不孤儿
        with(t(), () -> appRoles.addMember(1, appId, 2, List.of("app_admin"), 1L, "ip", "ua"));
        int threads = 2;
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(threads);
        try {
            java.util.concurrent.CountDownLatch ready = new java.util.concurrent.CountDownLatch(threads);
            java.util.concurrent.CountDownLatch go = new java.util.concurrent.CountDownLatch(1);
            java.util.List<java.util.concurrent.Future<Boolean>> futures = new java.util.ArrayList<>();
            for (int i = 0; i < threads; i++) {
                final long target = i == 0 ? 2L : 1L;   // T1 移除用户2，T2 移除用户1
                final long operator = i == 0 ? 1L : 2L;
                futures.add(pool.submit(() -> {
                    ready.countDown();
                    go.await();
                    try {
                        TenantContext.with(new TenantInfo(1, appId, operator), () -> {
                            appRoles.removeMember(1, appId, target, operator, "ip", "ua");
                            return null;
                        });
                        return true;
                    } catch (Exception e) {
                        return false;
                    }
                }));
            }
            ready.await();
            go.countDown();
            int success = 0;
            for (var f : futures) {
                if (f.get(10, java.util.concurrent.TimeUnit.SECONDS)) success++;
            }
            assertEquals(1, success, "并发互相移除恰一个成功（另一个被最后管理员保护拦下）");
            // 应用仍有管理员（非孤儿）
            boolean hasAdmin = TenantContext.with(t(), () -> appRoles.hasAppAdmin(1, appId));
            assertTrue(hasAdmin, "并发移除后应用仍须有管理员");
        } finally {
            pool.shutdownNow();
        }
    }

    // ---------- 工作台可见性 ----------

    @Test
    void workspaceListFilteredByMembership() {
        // 用户 2 无任何应用角色 → 卡片墙不可见该应用
        TenantInfo user2 = new TenantInfo(1, appId, 2);
        Map<String, Object> list2 = TenantContext.with(user2, () -> apps.list(null, false));
        List<?> items2 = (List<?>) list2.get("list");
        boolean visible = items2.stream().anyMatch(i -> ((Number) ((Map<?, ?>) i).get("id")).longValue() == appId);
        assertFalse(visible, "非成员不应看到应用卡片");
        // 授权后可见
        with(t(), () -> appRoles.addMember(1, appId, 2, List.of("user"), 1L, "ip", "ua"));
        Map<String, Object> listAfter = TenantContext.with(user2, () -> apps.list(null, false));
        List<?> itemsAfter = (List<?>) listAfter.get("list");
        boolean visibleAfter = itemsAfter.stream().anyMatch(i -> ((Number) ((Map<?, ?>) i).get("id")).longValue() == appId);
        assertTrue(visibleAfter, "成员应看到应用卡片");
    }

    @Test
    void orgManageHolderIsBoundedFallbackAdmin() {
        // org:manage 平台管理员兜底：可为非本应用管理员的应用做管理动作（13BE §3.1 兜底口径）
        // 用户 2 先无角色 → PERM_DENIED（上一用例已覆盖），此处验证持 org:manage 后放行
        Long permRoleId = ensureTenantRole("org_manager_it", "组织管理员IT");
        jdbc.update("INSERT INTO sys_role_permission (role_id, resource_type, resource_id, action) "
                + "VALUES (?, 'ACTION', 0, 'org:manage') ON CONFLICT DO NOTHING", permRoleId);
        jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (2, ?) ON CONFLICT DO NOTHING",
                permRoleId);
        TenantInfo orgManager = new TenantInfo(1, appId, 2);
        // 兜底放行：详情可读
        Map<String, Object> detail = TenantContext.with(orgManager, () -> apps.detail(appId));
        assertEquals(appId, ((Number) detail.get("id")).longValue());
        // 清理（防污染其他用例）
        jdbc.update("DELETE FROM sys_user_role WHERE user_id=2 AND role_id=?", permRoleId);
    }

    /** 租户级（无 app_id）角色幂等种子。 */
    private Long ensureTenantRole(String code, String name) {
        List<Long> existing = jdbc.query(
                "SELECT id FROM sys_role WHERE tenant_id=1 AND code=? AND app_id IS NULL LIMIT 1",
                (rs, i) -> rs.getLong(1), code);
        if (!existing.isEmpty()) {
            return existing.get(0);
        }
        jdbc.update("INSERT INTO sys_role (tenant_id, code, name, role_type) VALUES (1, ?, ?, 'TENANT')",
                code, name);
        return jdbc.queryForObject(
                "SELECT id FROM sys_role WHERE tenant_id=1 AND code=? AND app_id IS NULL", Long.class, code);
    }
}