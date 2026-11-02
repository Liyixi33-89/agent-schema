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

    @Test
    void archiveAndRestoreLifecycle() {
        with(t(), () -> apps.archive(appId));
        assertEquals("ARCHIVED", TenantContext.with(t(), () ->
                ((String) apps.detail(appId).get("status"))));
        // 归档态不可编辑导航
        BizException nav = assertThrows(BizException.class, () -> TenantContext.with(t(),
                () -> apps.saveNav(appId, List.of(), 1)));
        assertEquals("APP_NOT_EDITABLE", nav.code());
        with(t(), () -> apps.restore(appId));
        assertEquals("ACTIVE", TenantContext.with(t(), () ->
                ((String) apps.detail(appId).get("status"))));
    }

    @Test
    void deleteMarksDeletingWithImpact() {
        Map<String, Object> resp = TenantContext.with(t(), () -> apps.delete(appId));
        assertNotNull(resp.get("impact"));
        assertEquals("DELETING", jdbc.queryForObject(
                "SELECT status FROM app WHERE id=?", String.class, appId));
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
}