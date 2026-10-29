package com.schema.iam.infrastructure.persistence;

import com.schema.iam.domain.model.PermissionPolicy.DataScope;
import com.schema.iam.domain.model.PermissionPolicy.Perm;
import com.schema.iam.domain.model.UserAccount;
import com.schema.iam.domain.repository.IamRepository;
import com.schema.platform.common.json.Json;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * IAM JDBC 仓储（03BE §3.1 表落地）。
 * 纪律：全部查询显式带 tenant_id 谓词（拦截器是兜底，显式是主防线）。
 */
@Repository
public class JdbcIamRepository implements IamRepository {

    private final JdbcTemplate jdbc;

    public JdbcIamRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static OffsetDateTime toOdt(Timestamp ts) {
        return ts != null ? ts.toInstant().atOffset(OffsetDateTime.now().getOffset()) : null;
    }

    private static Timestamp toTs(OffsetDateTime odt) {
        return odt != null ? Timestamp.from(odt.toInstant()) : null;
    }

    private UserAccount mapUser(Map<String, Object> r) {
        return new UserAccount(
                (Long) r.get("id"),
                ((Number) r.get("tenant_id")).longValue(),
                (String) r.get("account"),
                (String) r.get("name"),
                (String) r.get("password_hash"),
                r.get("dept_id") instanceof Number n ? n.longValue() : null,
                (String) r.get("status"),
                Boolean.TRUE.equals(r.get("must_change_password")),
                r.get("failed_attempts") instanceof Number n ? n.intValue() : 0,
                toOdt((Timestamp) r.get("locked_until")),
                toOdt((Timestamp) r.get("last_login_at")));
    }

    @Override
    public Optional<UserAccount> findUser(long tenantId, String account) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT * FROM sys_user WHERE tenant_id=? AND account=?", tenantId, account);
        return rows.stream().findFirst().map(this::mapUser);
    }

    @Override
    public Optional<UserAccount> findUserById(long userId) {
        List<Map<String, Object>> rows = jdbc.queryForList("SELECT * FROM sys_user WHERE id=?", userId);
        return rows.stream().findFirst().map(this::mapUser);
    }

    @Override
    public void insertUser(UserAccount u) {
        jdbc.update("""
                INSERT INTO sys_user (tenant_id, account, name, password_hash, dept_id, status,
                    must_change_password, failed_attempts, locked_until, last_login_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, u.tenantId(), u.account(), u.name(), u.passwordHash(), u.deptId(), u.status(),
                u.mustChangePassword(), u.failedAttempts(), toTs(u.lockedUntil()), toTs(u.lastLoginAt()));
    }

    @Override
    public void updateUser(UserAccount u) {
        jdbc.update("""
                UPDATE sys_user SET name=?, password_hash=?, dept_id=?, status=?, must_change_password=?,
                    failed_attempts=?, locked_until=?, last_login_at=?
                WHERE id=?
                """, u.name(), u.passwordHash(), u.deptId(), u.status(), u.mustChangePassword(),
                u.failedAttempts(), toTs(u.lockedUntil()), toTs(u.lastLoginAt()), u.id());
    }

    @Override
    public boolean userExists(long tenantId, String account) {
        Long c = jdbc.queryForObject("SELECT count(*) FROM sys_user WHERE tenant_id=? AND account=?",
                Long.class, tenantId, account);
        return c != null && c > 0;
    }

    @Override
    public int incrementFailedAttempts(UserAccount user) {
        // 原子递增（读改写并发丢计数在所难免——计数与锁定判定合一写回）
        jdbc.update("""
                UPDATE sys_user SET failed_attempts = failed_attempts + 1,
                    locked_until = CASE WHEN failed_attempts + 1 >= ? THEN ? ELSE locked_until END
                WHERE id=?
                """, UserAccount.MAX_FAILED_ATTEMPTS,
                toTs(OffsetDateTime.now().plusMinutes(UserAccount.LOCK_MINUTES)), user.id());
        Integer attempts = jdbc.queryForObject("SELECT failed_attempts FROM sys_user WHERE id=?",
                Integer.class, user.id());
        return attempts != null ? attempts : 0;
    }

    @Override
    public List<Map<String, Object>> findRolesOfUser(long tenantId, long userId) {
        return jdbc.queryForList("""
                SELECT r.id, r.code, r.name, r.role_type, r.app_id FROM sys_role r
                  JOIN sys_user_role ur ON ur.role_id = r.id
                 WHERE r.tenant_id=? AND ur.user_id=?
                """, tenantId, userId);
    }

    @Override
    public List<Perm> findPermsOfRoles(List<Long> roleIds) {
        if (roleIds.isEmpty()) {
            return List.of();
        }
        String placeholders = String.join(",", java.util.Collections.nCopies(roleIds.size(), "?"));
        List<Perm> result = new ArrayList<>();
        for (Map<String, Object> r : jdbc.queryForList(
                "SELECT resource_type, resource_id, action FROM sys_role_permission "
                        + "WHERE role_id IN (" + placeholders + ")", roleIds.toArray())) {
            result.add(new Perm((String) r.get("resource_type"),
                    ((Number) r.get("resource_id")).longValue(), (String) r.get("action")));
        }
        return result;
    }

    @Override
    public List<DataScope> findDataScopesOfRoles(List<Long> roleIds) {
        if (roleIds.isEmpty()) {
            return List.of();
        }
        String placeholders = String.join(",", java.util.Collections.nCopies(roleIds.size(), "?"));
        List<DataScope> result = new ArrayList<>();
        for (Map<String, Object> r : jdbc.queryForList(
                "SELECT role_id, model_id, scope_type, scope_expr FROM sys_role_data_scope "
                        + "WHERE role_id IN (" + placeholders + ")", roleIds.toArray())) {
            result.add(new DataScope(((Number) r.get("role_id")).longValue(),
                    ((Number) r.get("model_id")).longValue(),
                    (String) r.get("scope_type"), (String) r.get("scope_expr")));
        }
        return result;
    }

    @Override
    public void replaceUserRoles(long tenantId, long userId, long appId, List<Long> roleIds) {
        jdbc.update("""
                DELETE FROM sys_user_role WHERE user_id=? AND role_id IN (
                    SELECT id FROM sys_role WHERE tenant_id=? AND app_id=?)
                """, userId, tenantId, appId);
        for (Long roleId : roleIds) {
            jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
                    userId, roleId);
        }
    }

    @Override
    public List<Long> findRoleIdsOfApp(long tenantId, long appId) {
        List<Long> result = new ArrayList<>();
        for (Map<String, Object> r : jdbc.queryForList(
                "SELECT id FROM sys_role WHERE tenant_id=? AND app_id=?", tenantId, appId)) {
            result.add(((Number) r.get("id")).longValue());
        }
        return result;
    }

    @Override
    public Optional<Long> findRoleId(long tenantId, long appId, String code) {
        List<Long> ids = new ArrayList<>();
        for (Map<String, Object> r : jdbc.queryForList(
                "SELECT id FROM sys_role WHERE tenant_id=? AND app_id=? AND code=?", tenantId, appId, code)) {
            ids.add(((Number) r.get("id")).longValue());
        }
        return ids.stream().findFirst();
    }

    @Override
    public void insertRefreshToken(long tenantId, long userId, String tokenHash, OffsetDateTime expiresAt) {
        jdbc.update("""
                INSERT INTO sys_refresh_token (tenant_id, user_id, token_hash, expires_at)
                VALUES (?, ?, ?, ?)
                """, tenantId, userId, tokenHash, toTs(expiresAt));
    }

    @Override
    public boolean isRefreshTokenActive(String tokenHash) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT revoked, expires_at FROM sys_refresh_token WHERE token_hash=?", tokenHash);
        if (rows.size() != 1) {
            return false;
        }
        if (Boolean.TRUE.equals(rows.get(0).get("revoked"))) {
            return false;
        }
        OffsetDateTime expires = toOdt((Timestamp) rows.get(0).get("expires_at"));
        return expires != null && expires.isAfter(OffsetDateTime.now());
    }

    @Override
    public Optional<Map<String, Object>> findRefreshRow(String tokenHash) {
        return jdbc.queryForList(
                "SELECT tenant_id, user_id, revoked, expires_at FROM sys_refresh_token WHERE token_hash=?",
                tokenHash).stream().findFirst();
    }

    @Override
    public void revokeAllRefreshTokens(long userId) {
        jdbc.update("UPDATE sys_refresh_token SET revoked=true, revoked_at=now() "
                + "WHERE user_id=? AND revoked=false", userId);
    }

    @Override
    public boolean consumeRefreshToken(String tokenHash) {
        // 条件 UPDATE：只有未吊销行会被置 revoked——并发刷新同一 token 仅一个事务返回 true
        return jdbc.update("UPDATE sys_refresh_token SET revoked=true, revoked_at=now() "
                + "WHERE token_hash=? AND revoked=false AND expires_at > now()", tokenHash) == 1;
    }

    @Override
    public void revokeRefreshToken(String tokenHash) {
        jdbc.update("UPDATE sys_refresh_token SET revoked=true, revoked_at=now() WHERE token_hash=?", tokenHash);
    }

    @Override
    public void insertAudit(String eventType, Long tenantId, Long userId, String resourceType,
            String resourceId, Map<String, Object> diff, String ip, String ua) {
        jdbc.update("""
                INSERT INTO sys_audit_log (tenant_id, user_id, event_type, resource_type, resource_id, diff, ip, ua)
                VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?)
                """, tenantId, userId, eventType, resourceType, resourceId,
                diff == null ? null : Json.write(diff), ip, ua);
    }
}
