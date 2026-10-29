package com.schema.bootstrap;

import com.schema.iam.application.AuthService;
import com.schema.iam.domain.model.PermissionPolicy.Perm;
import com.schema.iam.domain.model.UserAccount;
import com.schema.iam.domain.repository.IamRepository;
import com.schema.iam.infrastructure.security.JwtCodec;
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
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * M3 权限基座集成测试（真实 PG，03BE §7 硬性要求）：
 * 登录锁定 / 刷新滚动吊销 / 强制改密拦截与恢复 / JWT 租户绑定 / RBAC 快照 / 一次性密码。
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
class IamServiceIT {

    private static final TenantInfo T1 = new TenantInfo(1, 1, 1);
    private static final TenantInfo T2 = new TenantInfo(2, 1, 1);

    @Autowired
    private AuthService auth;

    @Autowired
    private IamRepository iam;

    @Autowired
    private JwtCodec jwt;

    @Autowired
    private JdbcTemplate jdbc;

    private long userId;
    private static final String ACCOUNT = "alice";

    @BeforeAll
    void warmup() {
        jdbc.update("DELETE FROM sys_user_role");
        jdbc.update("DELETE FROM sys_role_permission");
        jdbc.update("DELETE FROM sys_role_data_scope");
        jdbc.update("DELETE FROM sys_refresh_token");
        jdbc.update("DELETE FROM sys_audit_log");
        jdbc.update("DELETE FROM sys_role");
        jdbc.update("DELETE FROM sys_dept");
        jdbc.update("DELETE FROM sys_user");
        // 种子：角色 + 权限点（租户 1，应用 1）
        jdbc.update("INSERT INTO sys_role (tenant_id, code, name, role_type, app_id) VALUES (1, 'app_admin', '应用管理员', 'APP', 1)");
        Long roleId = jdbc.queryForObject("SELECT id FROM sys_role WHERE tenant_id=1 AND code='app_admin'", Long.class);
        jdbc.update("INSERT INTO sys_role_permission (role_id, resource_type, resource_id, action) VALUES (?, 'PAGE', 9001, 'view')", roleId);
        jdbc.update("INSERT INTO sys_role_permission (role_id, resource_type, resource_id, action) VALUES (?, 'ACTION', 0, 'model:design')", roleId);
    }

    @BeforeEach
    void setUp() {
        Map<String, Object> created = TenantContext.with(T1, () ->
                auth.createMember(1, ACCOUNT + System.nanoTime(), "Alice", null, "InitPass123", 1L, "test", "test"));
        String account = (String) created.get("username");
        userId = jdbc.queryForObject("SELECT id FROM sys_user WHERE account=?", Long.class, account);
    }

    @AfterEach
    void cleanup() {
        TenantContext.clear();
    }

    private String currentAccount() {
        return jdbc.queryForObject("SELECT account FROM sys_user WHERE id=?", String.class, userId);
    }

    private Map<String, Object> loginOk(String account) {
        return TenantContext.with(T1, () -> auth.login(1, account, "InitPass123", "test", "test"));
    }

    // ---------- 03BE §7：登录锁定 ----------

    @Test
    void loginLockedAfterFiveFailures() {
        String account = currentAccount();
        // 5 次错误密码
        for (int i = 0; i < 5; i++) {
            final int round = i;
            TenantContext.with(T1, () -> {
                try {
                    auth.login(1, account, "WrongPass" + round, "test", "test");
                    return null;
                } catch (BizException e) {
                    return e;
                }
            });
        }
        // 第 6 次：正确密码也被锁（423 ACCOUNT_LOCKED）
        BizException locked = TenantContext.with(T1, () -> {
            try {
                auth.login(1, account, "InitPass123", "test", "test");
                return null;
            } catch (BizException e) {
                return e;
            }
        });
        assertNotNull(locked, "锁定后正确密码也必须拒绝");
        assertEquals("ACCOUNT_LOCKED", locked.code());

        // 不存在账号与错误密码同文案（防枚举）
        BizException unknown = TenantContext.with(T1, () -> {
            try {
                auth.login(1, "no_such_user", "whatever1", "test", "test");
                return null;
            } catch (BizException e) {
                return e;
            }
        });
        assertEquals("UNAUTHORIZED", unknown.code());
        assertEquals("账号或密码错误", unknown.getMessage());
    }

    // ---------- 03BE §7：JWT 吊销 / 刷新滚动 ----------

    @Test
    void refreshRotatesAndOldTokenRevoked() {
        String account = currentAccount();
        Map<String, Object> session = loginOk(account);
        String refresh1 = (String) session.get("refreshToken");
        assertNotNull(refresh1);

        // 滚动刷新：新对签发
        Map<String, Object> rotated = TenantContext.with(T1, () -> auth.refresh(refresh1, "test", "test"));
        String refresh2 = (String) rotated.get("refreshToken");
        assertNotNull(rotated.get("accessToken"));
        assertFalse(refresh2.equals(refresh1), "refresh 必须滚动签发");

        // 旧 token 再来：REFRESH_REVOKED（重放检测）
        BizException replay = TenantContext.with(T1, () -> {
            try {
                auth.refresh(refresh1, "test", "test");
                return null;
            } catch (BizException e) {
                return e;
            }
        });
        assertNotNull(replay);
        assertEquals("REFRESH_REVOKED", replay.code());
    }

    // ---------- 03BE §7：P1 建号/重置一次性密码 ----------

    @Test
    void createMemberReturnsOneTimePasswordOnce() {
        // 建号响应带一次性密码 + mustChangePassword
        Map<String, Object> created = TenantContext.with(T1, () ->
                auth.createMember(1, "bob_" + System.nanoTime(), "Bob", null, null, 1L, "test", "test"));
        String oneTime = (String) created.get("initialPassword");
        assertNotNull(oneTime, "缺省时服务端生成一次性密码");
        assertTrue(oneTime.length() >= 8);

        // 库中无明文（bcrypt）
        String hash = jdbc.queryForObject("SELECT password_hash FROM sys_user WHERE account=?",
                String.class, created.get("username"));
        assertFalse(hash.contains(oneTime), "一次性密码不得明文落库");

        // 重复账号拒绝
        String dupAccount = (String) created.get("username");
        BizException dup = TenantContext.with(T1, () -> {
            try {
                auth.createMember(1, dupAccount, "Dup", null, null, 1L, "test", "test");
                return null;
            } catch (BizException e) {
                return e;
            }
        });
        assertEquals("ACCOUNT_DUPLICATED", dup.code());

        // 密码策略：短密码拒绝
        BizException weak = TenantContext.with(T1, () -> {
            try {
                auth.createMember(1, "weak_" + System.nanoTime(), "Weak", null, "short", 1L, "test", "test");
                return null;
            } catch (BizException e) {
                return e;
            }
        });
        assertEquals("PASSWORD_POLICY_VIOLATION", weak.code());
    }

    // ---------- 03BE §7：改密会话恢复（改密即换会话 + 多设备踢出） ----------

    @Test
    void changePasswordIssuesNewSessionAndKicksOthers() {
        String account = currentAccount();
        Map<String, Object> session = loginOk(account);
        String oldRefresh = (String) session.get("refreshToken");

        // 改密响应内联签发新 token 对（不强制重登录）
        Map<String, Object> changed = TenantContext.with(T1, () ->
                auth.changePassword(1, userId, "InitPass123", "NewPass456", "test", "test"));
        assertNotNull(changed.get("accessToken"), "改密响应必须内联新 access");
        assertNotNull(changed.get("refreshToken"), "改密响应必须内联新 refresh");
        assertEquals(false, changed.get("mustChangePassword"));

        // 旧 refresh 刷新被拒（多设备踢出）
        BizException kicked = TenantContext.with(T1, () -> {
            try {
                auth.refresh(oldRefresh, "test", "test");
                return null;
            } catch (BizException e) {
                return e;
            }
        });
        assertEquals("REFRESH_REVOKED", kicked.code());

        // 新密码可登录
        Map<String, Object> relogin = TenantContext.with(T1, () -> auth.login(1, account, "NewPass456", "test", "test"));
        assertNotNull(relogin.get("accessToken"));
    }

    // ---------- 03BE §7：JWT claim 与租户头绑定（JwtCodec 层） ----------

    @Test
    void jwtClaimsCarryTenantAndType() {
        String access = jwt.issueAccess(userId, 1);
        JwtCodec.Claims claims = jwt.verify(access);
        assertNotNull(claims);
        assertEquals(userId, claims.userId());
        assertEquals(1L, claims.tenantId());
        assertEquals("access", claims.tokenType());

        // refresh 型 token 不能当 access 用（过滤器层校验 typ）
        String refreshAsAccess = jwt.issueRefresh(userId, 1);
        JwtCodec.Claims refreshClaims = jwt.verify(refreshAsAccess);
        assertEquals("refresh", refreshClaims.tokenType());

        // 篡改签名无效
        assertNull(jwt.verify(access.substring(0, access.length() - 3) + "xxx"));
        // 过期/伪造结构无效
        assertNull(jwt.verify("not.a.jwt"));
    }

    // ---------- 03BE §7：RBAC 快照（perms 串） ----------

    @Test
    void meReturnsPermsSnapshotFromRoles() {
        String account = currentAccount();
        // 授权 app_admin 角色
        Long roleId = jdbc.queryForObject("SELECT id FROM sys_role WHERE tenant_id=1 AND code='app_admin'", Long.class);
        TenantContext.with(T1, () -> {
            auth.grantRoles(1, userId, 1, List.of(roleId), 1L, "test", "test");
            return null;
        });

        TenantContext.with(new TenantInfo(1, 1, userId), () -> {
            Map<String, Object> me = auth.me();
            @SuppressWarnings("unchecked")
            List<String> perms = (List<String>) me.get("perms");
            assertTrue(perms.contains("page:view:9001"), "perms 快照含页面权限点");
            assertTrue(perms.contains("action:model:design"), "perms 快照含动作权限点");
            @SuppressWarnings("unchecked")
            List<String> roles = (List<String>) me.get("roles");
            assertTrue(roles.contains("app_admin"));
            return null;
        });

        // 跨租户授权拒绝：角色不属于租户 2
        BizException denied = TenantContext.with(T2, () -> {
            try {
                auth.grantRoles(2, userId, 1, List.of(roleId), 1L, "test", "test");
                return null;
            } catch (BizException e) {
                return e;
            }
        });
        assertEquals("ROLE_NOT_FOUND", denied.code(), "跨租户角色必须同判不存在");
    }

    // ---------- 03BE §7：管理员重置（强制改密 + 审计） ----------

    @Test
    void resetPasswordForcesChangeAndAudits() {
        Map<String, Object> reset = TenantContext.with(T1, () -> auth.resetPassword(1, userId, 1L, "test", "test"));
        String oneTime = (String) reset.get("initialPassword");
        assertNotNull(oneTime, "重置生成一次性密码");

        // must_change_password 已置位
        Boolean must = jdbc.queryForObject("SELECT must_change_password FROM sys_user WHERE id=?",
                Boolean.class, userId);
        assertTrue(must, "重置后必须强制改密");

        // 审计留痕
        Long audits = jdbc.queryForObject(
                "SELECT count(*) FROM sys_audit_log WHERE event_type='SENSITIVE_OP' "
                        + "AND resource_id=?", Long.class, currentAccount());
        assertTrue(audits >= 1, "重置密码必须记审计");

        // 跨租户重置同判不存在
        BizException cross = TenantContext.with(T2, () -> {
            try {
                auth.resetPassword(2, userId, 1L, "test", "test");
                return null;
            } catch (BizException e) {
                return e;
            }
        });
        assertEquals("USER_NOT_FOUND", cross.code());
    }

    // ---------- 03BE §7：越权（伪造上下文） ----------

    @Test
    void crossTenantLoginIsolated() {
        // 租户 1 的账号在租户 2 登录 → 同文案拒绝（不暴露存在性）
        String account = currentAccount();
        BizException e = TenantContext.with(T2, () -> {
            try {
                auth.login(2, account, "InitPass123", "test", "test");
                return null;
            } catch (BizException ex) {
                return ex;
            }
        });
        assertEquals("UNAUTHORIZED", e.code(), "跨租户登录必须拒绝");
        assertEquals("账号或密码错误", e.getMessage(), "不给账号存在性线索");
    }

    // ---------- 权限点串形态（03BE §A.2） ----------

    @Test
    void permStringFormatMatchesContract() {
        Perm page = new Perm("PAGE", 9001, "view");
        assertEquals("page:view:9001", page.toPermString());
        Perm action = new Perm("ACTION", 0, "model:design");
        assertEquals("action:model:design", action.toPermString());
    }
}
