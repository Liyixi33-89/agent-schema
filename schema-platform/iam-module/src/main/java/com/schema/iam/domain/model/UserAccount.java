package com.schema.iam.domain.model;

import java.time.OffsetDateTime;

/**
 * 用户聚合（03BE §3.1/§4）：登录锁定状态机 + 强制改密 + 启停用。
 * 纯领域对象——不依赖 Spring/JDBC（四层职责铁律）；持久化由仓储完成。
 */
public class UserAccount {

    public static final int MAX_FAILED_ATTEMPTS = 5;
    public static final int LOCK_MINUTES = 15;

    private Long id;
    private final long tenantId;
    private final String account;
    private String name;
    private String passwordHash;        // bcrypt
    private Long deptId;
    private String status;              // ACTIVE / DISABLED
    private boolean mustChangePassword;
    private int failedAttempts;
    private OffsetDateTime lockedUntil;
    private OffsetDateTime lastLoginAt;

    public UserAccount(Long id, long tenantId, String account, String name, String passwordHash,
            Long deptId, String status, boolean mustChangePassword, int failedAttempts,
            OffsetDateTime lockedUntil, OffsetDateTime lastLoginAt) {
        this.id = id;
        this.tenantId = tenantId;
        this.account = account;
        this.name = name;
        this.passwordHash = passwordHash;
        this.deptId = deptId;
        this.status = status;
        this.mustChangePassword = mustChangePassword;
        this.failedAttempts = failedAttempts;
        this.lockedUntil = lockedUntil;
        this.lastLoginAt = lastLoginAt;
    }

    // ---------- 登录判定（03BE §4：失败 5 次锁 15 分钟） ----------

    /** 登录前闸门：锁定中/停用直接拒（错误码由调用方映射，保持统一 401 相同文案防枚举）。 */
    public boolean loginBlocked(OffsetDateTime now) {
        return "DISABLED".equals(status) || (lockedUntil != null && lockedUntil.isAfter(now));
    }

    /** 密码校验通过：清零失败计数、解锁、记录登录时间。 */
    public void loginSucceeded(OffsetDateTime now) {
        failedAttempts = 0;
        lockedUntil = null;
        lastLoginAt = now;
    }

    /** 密码校验失败：计数 +1，达阈值锁定。 */
    public void loginFailed(OffsetDateTime now) {
        failedAttempts++;
        if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
            lockedUntil = now.plusMinutes(LOCK_MINUTES);
        }
    }

    // ---------- 密码生命周期（03BE §A.3.1） ----------

    /** 校验密码策略：长度 ≥8 + 含字母数字（P1 最小策略）。 */
    public static void assertPasswordPolicy(String password) {
        if (password == null || password.length() < 8) {
            throw new IllegalArgumentException("密码长度不得少于 8 位");
        }
        boolean hasLetter = password.chars().anyMatch(Character::isLetter);
        boolean hasDigit = password.chars().anyMatch(Character::isDigit);
        if (!hasLetter || !hasDigit) {
            throw new IllegalArgumentException("密码必须同时包含字母与数字");
        }
    }

    /** 改密成功：换哈希 + 清强制改密标记（改密后由应用层吊销全部 refresh + 签发新 token 对）。 */
    public void changePassword(String newHash) {
        this.passwordHash = newHash;
        this.mustChangePassword = false;
    }

    /** 管理员重置：一次性密码 + 强制下次登录改密。 */
    public void resetPassword(String newHash) {
        this.passwordHash = newHash;
        this.mustChangePassword = true;
        this.failedAttempts = 0;
        this.lockedUntil = null;
    }

    // ---------- 访问器 ----------

    public Long id() { return id; }
    public void assignId(long id) { this.id = id; }
    public long tenantId() { return tenantId; }
    public String account() { return account; }
    public String name() { return name; }
    public String passwordHash() { return passwordHash; }
    public Long deptId() { return deptId; }
    public String status() { return status; }
    public boolean mustChangePassword() { return mustChangePassword; }
    public int failedAttempts() { return failedAttempts; }
    public OffsetDateTime lockedUntil() { return lockedUntil; }
    public OffsetDateTime lastLoginAt() { return lastLoginAt; }
}
