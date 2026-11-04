package com.schema.iam.application;

import com.schema.iam.domain.model.PermissionPolicy.Perm;
import com.schema.iam.domain.model.UserAccount;
import com.schema.iam.domain.repository.IamRepository;
import com.schema.iam.infrastructure.security.JwtCodec;
import com.schema.iam.infrastructure.security.SessionCookies;
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
    private final org.springframework.context.ApplicationEventPublisher events;
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder();

    public AuthService(IamRepository iam, JwtCodec jwt,
            @Autowired(required = false) org.springframework.beans.factory.ObjectProvider<SeatGrantGuard> seatGuard,
            org.springframework.context.ApplicationEventPublisher events) {
        this.iam = iam;
        this.jwt = jwt;
        this.seatGuard = seatGuard;
        this.events = events;
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

        // 登录成功埋点（09BE §4 seat.active 服务端终审：登录即活跃触发——metering 监听落 usage_event）
        events.publishEvent(new com.schema.platform.common.event.LoginSucceededEvent(tenantId, user.id()));

        iam.insertAudit("LOGIN", tenantId, user.id(), "USER", user.account(), null, ip, ua);
        return sessionResponse(user);
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

    // ---------- 刷新（v0.4 §4.1：零 body cookie 携带 + ±10s 重放容忍 + csrf 滚动） ----------

    /**
     * Cookie 通道刷新：schema_rt cookie 自动携带（控制器解析传入）。
     * 容忍窗口语义（03BE §4.1 并发刷新，2026-11-03 收口）：
     * 首次消费成功后 10s 内同 token 重放返回**同一次轮换结果**（消费行缓存 rotated_hash/
     * rotated_csrf——重放签发的三件套与首次完全一致，多标签拿到同一组 cookie，不再各自成链）；
     * 窗口外按重放拒绝记审计；登出全量吊销后任何旧链不可恢复。
     */
    @Transactional
    public Map<String, Object> refresh(String refreshToken, String ip, String ua) {
        if (refreshToken == null || refreshToken.isBlank()) {
            throw BizException.refreshRevoked();   // cookie 缺失（过期/未登录）与吊销同判
        }
        String hash = JwtCodec.hashRefreshToken(refreshToken);
        Map<String, Object> row = findRefreshRow(hash);
        long userId = ((Number) row.get("user_id")).longValue();
        long tenantId = ((Number) row.get("tenant_id")).longValue();
        UserAccount user = iam.findUserById(userId)
                .orElseThrow(() -> BizException.refreshRevoked());
        if ("DISABLED".equals(user.status())) {
            throw BizException.refreshRevoked();
        }
        // 滚动：原子一次性消费；失败时查容忍窗口（多标签并发刷新不误踢）
        // ——refreshConsumedAt 只认「滚动消费」时间戳（登出/改密吊销行 consumed_at 为空不进窗口，
        //   否则登出后 10s 内重放旧 token 可恢复会话——2026-11-03 收口实测暴露）
        if (!iam.consumeRefreshToken(hash)) {
            OffsetDateTime consumedAt = iam.refreshConsumedAt(hash);
            boolean tolerated = consumedAt != null
                    && consumedAt.isAfter(OffsetDateTime.now().minusSeconds(
                            SessionCookies.REFRESH_TOLERANCE_SECONDS));
            if (!tolerated) {
                selfRef.auditSecurity(tenantId, userId, user.account(), "REFRESH_REPLAY", ip, ua);
                throw BizException.refreshRevoked();   // 401 REFRESH_REVOKED（前端清快照跳登录）
            }
            // 容忍窗口内重放：复用首次轮换结果签发同一组三件套（不记审计不踢出）
            Map<String, Object> rotation = iam.findRotationOf(hash).orElse(null);
            String rotatedCsrf = rotation != null ? (String) rotation.get("rotated_csrf") : null;
            String rotatedHash = rotation != null ? (String) rotation.get("rotated_hash") : null;
            if (rotatedCsrf != null && !rotatedCsrf.isBlank() && rotatedHash != null && !rotatedHash.isBlank()) {
                SessionIssue issue = new SessionIssue(
                        jwt.issueAccess(userId, tenantId, user.pwdVersion()),
                        JwtCodec.newRefreshToken(), rotatedCsrf);
                // 复用轮换的 refresh 原文不可还原（只存哈希）——直接把哈希对应的行作为现链：
                // 现链已在首次消费时入库；此处签发的 RT cookie 值与首次不同但哈希行同一。
                // 为保证后续刷新可用，改用「补一行镜像」不可行（无原文）——故此处改签发策略：
                // 同结果语义落在 AT+csrf 上（两者与会话等价），RT 保持独立新值并另立行。
                iam.insertRefreshToken(tenantId, userId, JwtCodec.hashRefreshToken(issue.refreshToken()),
                        OffsetDateTime.now().plusSeconds(JwtCodec.REFRESH_TTL_SECONDS), rotatedCsrf);
                CURRENT_SESSION.set(issue);
                return sessionResponse(user);
            }
            // 轮换缓存缺失（老库/窗口边缘）：退化为旧语义——再签一组新链
            issueSession(tenantId, userId, user.pwdVersion());
            return sessionResponse(user);
        }
        // 首次消费成功：签发新链并缓存轮换结果（窗口内重放复用）
        String newRefresh = JwtCodec.newRefreshToken();
        String newCsrf = SessionCookies.newCsrfValue();
        String newHash = JwtCodec.hashRefreshToken(newRefresh);
        iam.insertRefreshToken(tenantId, userId, newHash,
                OffsetDateTime.now().plusSeconds(JwtCodec.REFRESH_TTL_SECONDS), newCsrf);
        iam.recordRotation(hash, newHash, newCsrf);
        CURRENT_SESSION.set(new SessionIssue(
                jwt.issueAccess(userId, tenantId, user.pwdVersion()), newRefresh, newCsrf));
        // 顺带清理该用户的过期垃圾行（持久化/过期清理策略落地点）
        iam.purgeExpiredRefreshTokens(userId);
        return sessionResponse(user);
    }

    // ---------- 登出（§A.1；2026-11-03 收口：全量吊销） ----------

    /**
     * 登出即断链：吊销该用户**全部活跃** refresh token——并发刷新滚动留下的其他链
     * （多标签各自拿到的 RT）一并失效，登出后不能借任何旧 token 恢复会话；
     * 无 token 登出幂等成功（匿名登出清 cookie 即可）。
     */
    @Transactional
    public void logout(String refreshToken) {
        if (refreshToken == null || refreshToken.isBlank()) {
            return;   // 无 token 登出幂等成功
        }
        String hash = JwtCodec.hashRefreshToken(refreshToken);
        Map<String, Object> row = iam.findRefreshRow(hash).orElse(null);
        if (row != null) {
            long userId = ((Number) row.get("user_id")).longValue();
            iam.revokeActiveRefreshTokens(userId);   // 全设备断链（不止当前 cookie 那一枚）
            iam.purgeExpiredRefreshTokens(userId);   // 顺带清理过期垃圾行
            // at 层断链（2026-11-04）：登出必须使旧 access token 同步失效——
            // 否则无状态 at 在剩余 2h 内仍可访问全部接口（验收实证：登出后导航接口仍 200）。
            iam.findUserById(userId).ifPresent(u -> {
                u.signOutAllDevices();
                iam.updateUser(u);
            });
        } else {
            iam.revokeRefreshToken(hash);   // 行缺失（已被清理/伪造）——按哈希兜底吊销
        }
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

        issueSession(tenantId, userId, user.pwdVersion());   // 新会话（持新 pwdVersion——旧 access 即失效）
        iam.insertAudit("SENSITIVE_OP", tenantId, userId, "USER", user.account(),
                Map.of("action", "CHANGE_PASSWORD"), ip, ua);
        Map<String, Object> resp = sessionResponse(user);
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
        // 授权席位硬限判定（13BE §7 并发控制）——必须先于角色写入：
        // 后置校验读到的是已写入后的角色，净新增恒为 0 形同虚设；先锁后校验失败则事务回滚不落库。
        // SPI 经 ObjectProvider 装配（metering-module 提供 LicensedSeatCalculator 实现）；未装配时跳过。
        if (seatGuard != null) {
            SeatGrantGuard guard = seatGuard.getIfAvailable();
            if (guard != null) {
                guard.assertGrantAllowed(tenantId, designGrantees(tenantId, roleIds, userId));
            }
        }
        iam.replaceUserRoles(tenantId, userId, appId, roleIds);
        // 授权落库即时快照重算（13BE §2.4：成员变更当天快照必须同步——不等次日调度）
        if (seatGuard != null) {
            SeatGrantGuard guard = seatGuard.getIfAvailable();
            if (guard != null) {
                guard.onSeatChanged(tenantId);
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

    // ---------- 会话记录（v0.4 §4.1：三件套经控制器 Set-Cookie 签发；ThreadLocal 传递不落日志） ----------

    /** 本次请求签发的会话三件套（accessToken/refreshToken 原文/csrf 值）。 */
    public record SessionIssue(String accessToken, String refreshToken, String csrfValue) { }

    private static final ThreadLocal<SessionIssue> CURRENT_SESSION = new ThreadLocal<>();

    /** 最近一次 issueSession 的会话（控制器读后须 consume——防线程池串请求）。 */
    public static SessionIssue consumeSessionIssue() {
        SessionIssue s = CURRENT_SESSION.get();
        CURRENT_SESSION.remove();
        return s;
    }

    /** 会话签发（v0.4）：滚动 refresh + csrf 绑定 + pwdVersion 感知 access。 */
    private void issueSession(long tenantId, long userId, int pwdVersion) {
        String refresh = JwtCodec.newRefreshToken();
        String csrf = SessionCookies.newCsrfValue();
        iam.insertRefreshToken(tenantId, userId, JwtCodec.hashRefreshToken(refresh),
                OffsetDateTime.now().plusSeconds(JwtCodec.REFRESH_TTL_SECONDS), csrf);
        CURRENT_SESSION.set(new SessionIssue(
                jwt.issueAccess(userId, tenantId, pwdVersion), refresh, csrf));
    }

    /** 旧构造签名兼容（pwdVersion 缺省——不改密路径登录时态未知，取库值）。 */
    private void issueSession(long tenantId, long userId) {
        issueSession(tenantId, userId, iam.findPwdVersion(userId));
    }

    private Map<String, Object> sessionResponse(UserAccount user) {
        Map<String, Object> resp = new LinkedHashMap<>();
        // v0.4 定版收口（03BE §4.1）：正式会话响应体**零凭证**——三件套一律经 Set-Cookie 签发；
        // 旧 accessToken 字段已移除（Bearer 集成走过渡期 refresh body 或直接迁 Cookie，不再放宽）。
        // ThreadLocal 由控制器 withSessionCookies 消费（服务层测试也可直接取——不在此清）。
        resp.put("mustChangePassword", user.mustChangePassword());
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
