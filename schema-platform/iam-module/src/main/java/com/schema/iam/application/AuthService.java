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
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();

    public AuthService(IamRepository iam, JwtCodec jwt) {
        this.iam = iam;
        this.jwt = jwt;
    }

    // ---------- 登录（§A.1） ----------

    @Transactional
    public Map<String, Object> login(long tenantId, String account, String password, String ip, String ua) {
        UserAccount user = iam.findUser(tenantId, account).orElse(null);

        // 统一 401：不存在/停用/锁定/密码错同一文案同一码（防枚举）
        if (user == null) {
            iam.insertAudit("SECURITY", tenantId, null, "USER", account,
                    Map.of("reason", "LOGIN_UNKNOWN_ACCOUNT"), ip, ua);
            throw BizException.unauthorized(LOGIN_FAILED_MSG);
        }
        if (user.loginBlocked(OffsetDateTime.now())) {
            // 锁定也返回统一文案；审计记真实原因
            iam.insertAudit("SECURITY", tenantId, user.id(), "USER", user.account(),
                    Map.of("reason", "DISABLED".equals(user.status()) ? "LOGIN_DISABLED" : "LOGIN_LOCKED"),
                    ip, ua);
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
        user.loginFailed(OffsetDateTime.now());
        iam.updateUser(user);
        iam.insertAudit("SECURITY", user.tenantId(), user.id(), "USER", user.account(),
                Map.of("reason", "LOGIN_BAD_PASSWORD", "failedAttempts", user.failedAttempts()), ip, ua);
    }

    /** 自注入引用（Spring 代理 REQUIRES_NEW 必须经代理调用，直接内部调用不生效）。 */
    @Autowired
    @Lazy
    private AuthService selfRef;

    // ---------- 刷新（§A.1：滚动签发 + 旧 token 即刻吊销） ----------

    @Transactional
    public Map<String, Object> refresh(String refreshToken, String ip, String ua) {
        String hash = JwtCodec.hashRefreshToken(refreshToken);
        if (!iam.isRefreshTokenActive(hash)) {
            throw BizException.refreshRevoked();   // 401 REFRESH_REVOKED（前端清快照跳登录）
        }
        // 查回 token 归属用户（哈希索引查行）
        Map<String, Object> row = findRefreshRow(hash);
        long userId = ((Number) row.get("user_id")).longValue();
        long tenantId = ((Number) row.get("tenant_id")).longValue();
        UserAccount user = iam.findUserById(userId)
                .orElseThrow(() -> BizException.refreshRevoked());
        if ("DISABLED".equals(user.status())) {
            throw BizException.refreshRevoked();
        }
        // 滚动：旧 token 吊销 + 新对签发（重放检测：旧 token 再来命中 revoked → SECURITY 审计）
        iam.revokeRefreshToken(hash);
        issueSession(tenantId, userId);
        return sessionResponse(user, jwt.issueAccess(userId, tenantId));
    }

    // ---------- 登出（§A.1） ----------

    @Transactional
    public void logout(String refreshToken) {
        String hash = JwtCodec.hashRefreshToken(refreshToken);
        iam.revokeRefreshToken(hash);
    }

    // ---------- 当前用户与权限快照（§A.2） ----------

    public Map<String, Object> me() {
        TenantInfo ctx = TenantContext.get();
        UserAccount user = iam.findUserById(ctx.operatorId())
                .orElseThrow(() -> BizException.unauthorized("未登录"));
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

    // ---------- 成员建号（§A.3.1：一次性初始密码） ----------

    @Transactional
    public Map<String, Object> createMember(long tenantId, String account, String name, Long deptId,
            String initialPassword, Long operatorId, String ip, String ua) {
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

    // ---------- 管理员重置（§A.3.1：强制下次登录改密 + 记审计） ----------

    @Transactional
    public Map<String, Object> resetPassword(long tenantId, long userId, Long operatorId, String ip, String ua) {
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

    // ---------- 成员授权（§A.3：覆盖式） ----------

    @Transactional
    public void grantRoles(long tenantId, long userId, long appId, List<Long> roleIds, Long operatorId,
            String ip, String ua) {
        // 校验角色属于租户 + 应用
        for (Long roleId : roleIds) {
            boolean owned = iam.findRoleIdsOfApp(tenantId, appId).contains(roleId);
            if (!owned) {
                throw new BizException("ROLE_NOT_FOUND", "角色不属于该应用: " + roleId);
            }
        }
        iam.replaceUserRoles(tenantId, userId, appId, roleIds);
        iam.insertAudit("PERM_CHANGE", tenantId, operatorId, "USER", String.valueOf(userId),
                Map.of("action", "GRANT_ROLES", "appId", appId, "roleIds", roleIds), ip, ua);
    }

    // ---------- 内部 ----------

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
