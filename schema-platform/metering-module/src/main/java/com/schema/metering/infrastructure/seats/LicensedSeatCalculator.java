package com.schema.metering.infrastructure.seats;

import com.schema.iam.application.SeatGrantGuard;
import com.schema.platform.common.web.BizException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

/**
 * 授权席位判定（13BE §2.4 唯一实现点；M8.4）：
 * COUNT(DISTINCT user) WHERE 任一应用角色 ∈ {应用管理员, 开发者}——授权即计（无论是否操作）。
 * 单租户 MVP：租户内跨应用聚合；并发控制在事务内完成（锁-读-算-验原子序列）。
 */
@Component
public class LicensedSeatCalculator implements SeatGrantGuard {

    /** 设计能力角色编码（授权即计席位，13BE §2.4）。 */
    public static final List<String> DESIGN_ROLE_CODES = List.of("app_admin", "developer");

    private final JdbcTemplate jdbc;
    private final TransactionTemplate tx;
    /** 授权席位上限（13BE §2.4 硬限；0 = 不限制——tenant-service quota_profile 表落地前的默认口径）。 */
    private final long seatLimit;

    public LicensedSeatCalculator(JdbcTemplate jdbc, TransactionTemplate tx,
            @Value("${metering.seat-limit:0}") long seatLimit) {
        this.jdbc = jdbc;
        this.tx = tx;
        this.seatLimit = seatLimit;
    }

    /** 授权席位数（跨应用去重——席位判定看全租户聚合而非单应用）。 */
    public long licensedSeats(long tenantId) {
        Long n = jdbc.queryForObject("""
                SELECT COUNT(DISTINCT ur.user_id)
                FROM sys_user_role ur
                JOIN sys_role r ON r.id = ur.role_id
                WHERE r.tenant_id = ? AND r.code IN (?, ?)
                """, Long.class, tenantId,
                DESIGN_ROLE_CODES.get(0), DESIGN_ROLE_CODES.get(1));
        return n == null ? 0L : n;
    }

    /** 每日快照落库（授权口径不出计量事件——13BE §2.4）。 */
    public void snapshot(long tenantId, LocalDate date) {
        long seats = licensedSeats(tenantId);
        jdbc.update("""
                INSERT INTO seat_license_daily (tenant_id, stat_date, licensed_seats)
                VALUES (?, ?, ?)
                ON CONFLICT (tenant_id, stat_date) DO UPDATE SET licensed_seats = EXCLUDED.licensed_seats
                """, tenantId, date, seats);
    }

    /**
     * 新增设计能力角色触限判定（13BE §7 授权并发控制，SeatGrantGuard SPI 实现）：
     * 调用时机在角色写入之前。锁-读-算-验必须在同一事务内——语句级自动提交下
     * FOR UPDATE 锁读完即释放，并发授权互相看不见对方写入导致超限。
     * 事务边界内：锁当日快照行（串行化同租户并发）→ 读现态 → 算净新增 → 校验；
     * 超限抛 403 SEAT_LIMIT_EXCEEDED，调用方事务回滚角色不落库。
     *
     * @param tenantId             租户
     * @param userIdsGrantedDesign 本次将被授予设计能力角色的用户集合
     */
    @Override
    public void assertGrantAllowed(long tenantId, List<Long> userIdsGrantedDesign) {
        if (seatLimit <= 0 || userIdsGrantedDesign == null || userIdsGrantedDesign.isEmpty()) {
            return;
        }
        LocalDate today = LocalDate.now();
        // PROPAGATION_REQUIRED：并入调用方 grantRoles 事务（或独立事务）——锁到提交/回滚才释放
        tx.executeWithoutResult(status -> {
            // 串行化锚点：锁当日快照行；无行先占位插入（0 值占位由后续 snapshot 校正）
            jdbc.update("""
                    INSERT INTO seat_license_daily (tenant_id, stat_date, licensed_seats)
                    VALUES (?, ?, 0) ON CONFLICT (tenant_id, stat_date) DO NOTHING
                    """, tenantId, today);
            jdbc.queryForObject("""
                    SELECT licensed_seats FROM seat_license_daily
                    WHERE tenant_id = ? AND stat_date = ? FOR UPDATE
                    """, Long.class, tenantId, today);
            // 锁内读现态（调用时机在写入前——读到的是本次授权前的真实基数）
            long current = licensedSeats(tenantId);
            // 净新增 = 即将授予设计角色的用户中，当前不持任何设计能力角色的人数
            long netNew = userIdsGrantedDesign.stream()
                    .filter(uid -> !holdsDesignRole(tenantId, uid))
                    .count();
            if (current + netNew > seatLimit) {
                throw new BizException("SEAT_LIMIT_EXCEEDED", "新增设计能力角色超授权席位上限",
                        Map.of("licensedSeats", current, "limit", seatLimit));
            }
        });
    }

    /** 成员授权变更即时重算（13BE §2.4）：当天快照同步覆盖，不等次日调度。 */
    @Override
    public void onSeatChanged(long tenantId) {
        snapshot(tenantId, LocalDate.now());
    }

    /** 用户是否已持设计能力角色（跨应用任意一持即算）。 */
    private boolean holdsDesignRole(long tenantId, long userId) {
        Long n = jdbc.queryForObject("""
                SELECT COUNT(*) FROM sys_user_role ur
                JOIN sys_role r ON r.id = ur.role_id
                WHERE ur.user_id = ? AND r.tenant_id = ? AND r.code IN (?, ?)
                """, Long.class, userId, tenantId,
                DESIGN_ROLE_CODES.get(0), DESIGN_ROLE_CODES.get(1));
        return n != null && n > 0;
    }
}
