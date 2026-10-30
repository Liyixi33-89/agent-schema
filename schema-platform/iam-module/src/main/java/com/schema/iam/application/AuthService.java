package com.schema.iam.application;

import com.schema.iam.domain.model.PermissionPolicy.Perm;
import com.schema.iam.domain.model.UserAccount;
import com.schema.iam.domain.repository.IamRepository;
import com.schema.iam.infrastructure.security.JwtCodec;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Lazy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.security.SecureRandom;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 认证与成员服务（03BE §4/§A.1/§A.3.1）。
 * 统一 401 相同文案（防账号枚举）；一次性密码只返回一次；改密即换会话。
 */
@Service
public class AuthService {

    /** 登录失败统一文案（防账号枚举，03BE §4）。 */
    private static final String LOGIN_FAILED_MSG = "账号或密码错误";
    private static final SecureRandom RANDOM = new SecureRandom();

    private final IamRepository iam;
    private final JwtCodec jwt;
    private final org.springframework.beans.factory.ObjectProvider<SeatGrantGuard> seatGuard;
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();

    public AuthService(IamRepository iam, JwtCodec jwt,
            @Autowired(required = false) org.springframework.beans.factory.ObjectProvider<SeatGrantGuard> seatGuard) {
        this.iam = iam;
        this.jwt = jwt;
        this.seatGuard = seatGuard;
    }

    // ---------- 登录（§A.1） ----------

    @Transactional
    public Map<String, Object> login(long tenantId, String account, String password, String ip, String ua) {
        UserAccount user = iam.findUser(tenantId, account).orElse(null);

        // 统一 401：不存在/停用/锁定/密码错同一文案同一码（防枚举）
        if (user == null) {
            // 经代理调用（REQUIRES_NEW 独立提交）——直接 this. 调用绕过代理，审计会随主事务回滚
            selfRef.auditSecurity(tenantId, null, account, "LOGIN_UNKNOWN_ACCOUNT", ip, ua);
            throw BizException.unauthorized(LOGIN_FAILED_MSG);
        }
        if (user.loginBlocked(OffsetDateTime.now())) {
            // 锁定也返回统一文案；审计记真实原因（独立事务——主流程抛异常回滚不丢审计）
            selfRef.auditSecurity(tenantId, user.id(), user.account(),
                    "DISABLED".equals(user.status()) ? "LOGIN_DISABLED" : "LOGIN_LOCKED", ip, ua);
            throw BizException.unauthorizedOrLocked(user.lockedUntil());
        }
        if (!encoder.matches(password, user.passwordHash())) {
            // 失败计数与审计走独立事务（REQUIRES_NEW）——外层事务随异常回滚也不丢计数
            selfRef.recordLoginFailure(user, ip, ua);
            if (user.lockedUntil() != null) {
                throw BizException.unauthorizedOrLocked(user.lockedUntil());
            }
            throw BizException.unauthorized(LOGIN_FAILED_MSG);
        }

        user.loginSucceeded(OffsetDateTime.now());
        iam.updateUser(user);
        issueSession(tenantId, user.id());

        iam.insertAudit("LOGIN", tenantId, user.id(), "USER", user.account(), null, ip, ua);
        return sessionResponse(user, jwt.issueAccess(user.id(), tenantId));
    }

    /** 失败计数持久化（独立提交——login 主事务抛异常回滚不影响计数累积）。 */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void recordLoginFailure(UserAccount user, String ip, String ua) {
        // 原子递增（并发失败不丢计数）；锁定阈值判定在 SQL 内完成
        int attempts = iam.incrementFailedAttempts(user);
        iam.insertAudit("SECURITY", user.tenantId(), user.id(), "USER", user.account(),
                Map.of("reason", "LOGIN_BAD_PASSWORD", "failedAttempts", attempts), ip, ua);
    }

    /** 安全审计（独立事务）——拒绝路径的主事务必然回滚，审计必须另行提交。 */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void auditSecurity(Long tenantId, Long userId, String account, String reason,
            String ip, String ua) {
        iam.insertAudit("SECURITY", tenantId, userId, "USER", account,
                Map.of("reason", reason), ip, ua);
    }

    /** 自注入引用（Spring 代理 REQUIRES_NEW 必须经代理调用，直接内部调用不生效）。 */
    @Autowired
    @Lazy
    private AuthService selfRef;

    // ---------- 刷新（§A.1：滚动签发 + 旧 token 即刻吊销） ----------

    @Transactional
    public Map<String, Object> refresh(String refreshToken, String ip, String ua) {
        String hash = JwtCodec.hashRefreshToken(refreshToken);
        Map<String, Object> row = findRefreshRow(hash);
        long userId = ((Number) row.get("user_id")).longValue();
        long tenantId = ((Number) row.get("tenant_id")).longValue();
        UserAccount user = iam.findUserById(userId)
                .orElseThrow(() -> BizException.refreshRevoked());
        if ("DISABLED".equals(user.status())) {
            throw BizException.refreshRevoked();
        }
        // 滚动：原子一次性消费（并发刷新同一 token 仅一个成功）+ 新对签发；
        // 消费失败 = 已吊销/过期 → SECURITY 审计（重放检测）
        if (!iam.consumeRefreshToken(hash)) {
            selfRef.auditSecurity(tenantId, userId, user.account(), "REFRESH_REPLAY", ip, ua);
            throw BizException.refreshRevoked();   // 401 REFRESH_REVOKED（前端清快照跳登录）
        }
        issueSession(tenantId, userId);
        return sessionResponse(user, jwt.issueAccess(userId, tenantId));
    }

    // ---------- 登出（§A.1） ----------

    @Transactional
    public void logout(String refreshToken) {
        if (refreshToken == null || refreshToken.isBlank()) {
            return;   // 无 token 登出幂等成功
        }
        String hash = JwtCodec.hashRefreshToken(refreshToken);
        iam.revokeRefreshToken(hash);
    }

    // ---------- 当前用户与权限快照（§A.2） ----------

    public Map<String, Object> me() {
        TenantInfo ctx = TenantContext.get();
        UserAccount user = iam.findUserById(ctx.operatorId())
                .orElseThrow(() -> BizException.unauthorized("未登录"));
        assertTenantMatches(user, ctx.tenantId());
        List<Map<String, Object>> roles = iam.findRolesOfUser(ctx.tenantId(), user.id());
        List<Long> roleIds = roles.stream().map(r -> ((Number) r.get("id")).longValue()).toList();
        List<Perm> perms = iam.findPermsOfRoles(roleIds);

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("userId", user.id());
        resp.put("name", user.name());
        resp.put("account", user.account());
        resp.put("dept", user.deptId());
        resp.put("tenantId", user.tenantId());
        resp.put("mustChangePassword", user.mustChangePassword());
        List<String> roleCodes = new ArrayList<>();
        for (Map<String, Object> r : roles) {
            roleCodes.add((String) r.get("code"));
        }
        resp.put("roles", roleCodes);
        List<String> permStrings = new ArrayList<>();
        for (Perm p : perms) {
            permStrings.add(p.toPermString());
        }
        resp.put("perms", permStrings);
        return resp;
    }

    // ---------- 成员建号（§A.3.1：一次性初始密码；仅管理员） ----------

    @Transactional
    public Map<String, Object> createMember(long tenantId, String account, String name, Long deptId,
            String initialPassword, Long operatorId, String ip, String ua) {
        requireOrgManagePerm(tenantId, operatorId);
        if (iam.userExists(tenantId, account)) {
            throw new BizException("ACCOUNT_DUPLICATED", "账号已存在: " + account);
        }
        String password = initialPassword != null ? initialPassword : generateOneTimePassword();
        try {
            UserAccount.assertPasswordPolicy(password);
        } catch (IllegalArgumentException e) {
            throw new BizException("PASSWORD_POLICY_VIOLATION", e.getMessage());
        }
        UserAccount user = new UserAccount(null, tenantId, account, name,
                encoder.encode(password), deptId, "ACTIVE", true, 0, null, null);
        iam.insertUser(user);
        // 审计：谁为谁建号（一次性密码不落审计）
        iam.insertAudit("PERM_CHANGE", tenantId, operatorId, "USER", account,
                Map.of("action", "CREATE_MEMBER"), ip, ua);
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("username", account);
        resp.put("initialPassword", password);   // 只返回一次（入库为 bcrypt）
        resp.put("mustChangePassword", true);
        return resp;
    }

    // ---------- 管理员重置（§A.3.1：强制下次登录改密 + 记审计；仅管理员） ----------

    @Transactional
    public Map<String, Object> resetPassword(long tenantId, long userId, Long operatorId, String ip, String ua) {
        requireOrgManagePerm(tenantId, operatorId);
        UserAccount user = iam.findUserById(userId)
                .orElseThrow(() -> new BizException("USER_NOT_FOUND", "用户不存在"));
        if (user.tenantId() != tenantId) {
            throw new BizException("USER_NOT_FOUND", "用户不存在");   // 跨租户同判不存在
        }
        String oneTime = generateOneTimePassword();
        user.resetPassword(encoder.encode(oneTime));
        iam.updateUser(user);
        iam.revokeAllRefreshTokens(user.id());          // 停用既有会话
        iam.insertAudit("SENSITIVE_OP", tenantId, operatorId, "USER", user.account(),
                Map.of("action", "RESET_PASSWORD"), ip, ua);
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("initialPassword", oneTime);
        return resp;
    }

    // ---------- 本人改密（§A.3.1：改密即换会话——内联签发新 token 对） ----------

    @Transactional
    public Map<String, Object> changePassword(long tenantId, long userId, String oldPassword,
            String newPassword, String ip, String ua) {
        UserAccount user = iam.findUserById(userId)
                .orElseThrow(() -> BizException.unauthorized("未登录"));
        assertTenantMatches(user, tenantId);
        if (!encoder.matches(oldPassword, user.passwordHash())) {
            throw BizException.unauthorized("原密码错误");
        }
        UserAccount.assertPasswordPolicy(newPassword);
        user.changePassword(encoder.encode(newPassword));
        iam.updateUser(user);
        iam.revokeAllRefreshTokens(userId);             // 全部旧 refresh 入黑名单（多设备踢出）

        issueSession(tenantId, userId);                 // 新会话
        iam.insertAudit("SENSITIVE_OP", tenantId, userId, "USER", user.account(),
                Map.of("action", "CHANGE_PASSWORD"), ip, ua);
        Map<String, Object> resp = sessionResponse(user, jwt.issueAccess(userId, tenantId));
        resp.put("mustChangePassword", false);
        return resp;
    }

    // ---------- 成员授权（§A.3：覆盖式；仅管理员） ----------

    @Transactional
    public void grantRoles(long tenantId, long userId, long appId, List<Long> roleIds, Long operatorId,
            String ip, String ua) {
        requireOrgManagePerm(tenantId, operatorId);
        // 目标用户必须属于本租户（跨租户同判不存在）
        UserAccount target = iam.findUserById(userId)
                .orElseThrow(() -> new BizException("USER_NOT_FOUND", "用户不存在"));
        assertTenantMatches(target, tenantId);
        // 校验角色属于租户 + 应用
        for (Long roleId : roleIds) {
            boolean owned = iam.findRoleIdsOfApp(tenantId, appId).contains(roleId);
            if (!owned) {
                throw new BizException("ROLE_NOT_FOUND", "角色不属于该应用: " + roleId);
            }
        }
        iam.replaceUserRoles(tenantId, userId, appId, roleIds);
        // 授权席位硬限判定（13BE §7 并发控制）：本次授予设计能力角色的用户触限校验。
        // SPI 经 ObjectProvider 装配（metering-module 提供 LicensedSeatCalculator 实现）；未装配时跳过。
        if (seatGuard != null) {
            SeatGrantGuard guard = seatGuard.getIfAvailable();
            if (guard != null) {
                guard.assertGrantAllowed(tenantId, designGrantees(tenantId, roleIds, userId));
            }
        }
        iam.insertAudit("PERM_CHANGE", tenantId, operatorId, "USER", String.valueOf(userId),
                Map.of("action", "GRANT_ROLES", "appId", appId, "roleIds", roleIds), ip, ua);
    }

    /** 本次授予中持设计能力角色（app_admin/developer）的用户集合（触限校验输入）。 */
    private java.util.List<Long> designGrantees(long tenantId, List<Long> roleIds, long userId) {
        List<Long> design = new ArrayList<>();
        for (Long roleId : roleIds) {
            String code = iam.findRoleCode(roleId);
            if (code != null && ("app_admin".equals(code) || "developer".equals(code))) {
                design.add(userId);
                break;
            }
        }
        return design;
    }

    // ---------- 内部 ----------

    /** 组织管理权限点（03BE §A.3 管理端；perms 串形态 action:org:manage）。 */
    private static final String ORG_MANAGE_PERM = "action:org:manage";

    /**
     * 管理端权限闸门（03BE §3.2「逐请求走判定链」）：操作者必须持有 org:manage 权限点。
     * perms 快照仅供前端展示/路由；后端逐请求从角色实时判定，快照不作数。
     */
    private void requireOrgManagePerm(long tenantId, Long operatorId) {
        if (operatorId == null || operatorId <= 0) {
            throw BizException.permDenied();
        }
        UserAccount operator = iam.findUserById(operatorId).orElse(null);
        if (operator == null || operator.tenantId() != tenantId) {
            throw BizException.permDenied();
        }
        List<Map<String, Object>> roles = iam.findRolesOfUser(tenantId, operatorId);
        List<Long> roleIds = roles.stream().map(r -> ((Number) r.get("id")).longValue()).toList();
        boolean granted = iam.findPermsOfRoles(roleIds).stream()
                .anyMatch(p -> ORG_MANAGE_PERM.equals(p.toPermString()));
        if (!granted) {
            throw BizException.permDenied();
        }
    }

    /** 用户与当前租户一致性（上下文租户为真源；不一致视同未授权——不给跨租户存在性线索）。 */
    private static void assertTenantMatches(UserAccount user, long tenantId) {
        if (user.tenantId() != tenantId) {
            throw new BizException("USER_NOT_FOUND", "用户不存在");
        }
    }

    private void issueSession(long tenantId, long userId) {
        String refresh = JwtCodec.newRefreshToken();
        iam.insertRefreshToken(tenantId, userId, JwtCodec.hashRefreshToken(refresh),
                OffsetDateTime.now().plusSeconds(JwtCodec.REFRESH_TTL_SECONDS));
        // refresh 原文经 ThreadLocal 传递给 sessionResponse（不落日志）
        CURRENT_REFRESH.set(new StringBuilder(refresh));
    }

    private static final ThreadLocal<StringBuilder> CURRENT_REFRESH = new ThreadLocal<>();

    private Map<String, Object> sessionResponse(UserAccount user, String accessToken) {
        StringBuilder refresh = CURRENT_REFRESH.get();
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("accessToken", accessToken);
        resp.put("refreshToken", refresh != null ? refresh.toString() : null);
        resp.put("mustChangePassword", user.mustChangePassword());
        CURRENT_REFRESH.remove();
        return resp;
    }

    private Map<String, Object> findRefreshRow(String hash) {
        return iam.findRefreshRow(hash).orElseThrow(BizException::refreshRevoked);
    }

    private static String generateOneTimePassword() {
        // 12 位字母数字：首位字母 + 第二位数字 + 其余随机（保证满足策略「含字母且含数字」——
        // 纯随机 12 位有 ~6% 概率全字母导致建号被自家策略拒绝，CI 已实证）
        String letters = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";
        String digits = "23456789";
        String alphabet = letters + digits;
        StringBuilder sb = new StringBuilder(12);
        sb.append(letters.charAt(RANDOM.nextInt(letters.length())));
        sb.append(digits.charAt(RANDOM.nextInt(digits.length())));
        for (int i = 2; i < 12; i++) {
            sb.append(alphabet.charAt(RANDOM.nextInt(alphabet.length())));
        }
        return sb.toString();
    }
}
