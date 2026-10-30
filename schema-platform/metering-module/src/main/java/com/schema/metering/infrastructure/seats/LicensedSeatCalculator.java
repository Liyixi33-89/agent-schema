package com.schema.metering.infrastructure.seats;

import com.schema.iam.application.SeatGrantGuard;
import com.schema.platform.common.web.BizException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

/**
 * 授权席位判定（13BE §2.4 唯一实现点；M8.4）：
 * COUNT(DISTINCT user) WHERE 任一应用角色 ∈ {应用管理员, 开发者}——授权即计（无论是否操作）。
 * 单租户 MVP：租户内跨应用聚合；上限判定 + SELECT FOR UPDATE 并发控制在授权挂点生效（assertGrantAllowed）。
 */
@Component
public class LicensedSeatCalculator implements SeatGrantGuard {

    /** 设计能力角色编码（授权即计席位，13BE §2.4）。 */
    public static final List<String> DESIGN_ROLE_CODES = List.of("app_admin", "developer");

    private final JdbcTemplate jdbc;
    /** 授权席位上限（13BE §2.4 硬限；0 = 不限制——tenant-service quota_profile 表落地前的默认口径）。 */
    private final long seatLimit;

    public LicensedSeatCalculator(JdbcTemplate jdbc,
            @Value("${metering.seat-limit:0}") long seatLimit) {
        this.jdbc = jdbc;
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
     * SELECT FOR UPDATE 锁租户当日席位快照行串行化同租户并发授权；
     * 校验「现有授权数 + 本次净新增」不超上限，超限抛 403 SEAT_LIMIT_EXCEEDED。
     *
     * @param tenantId             租户
     * @param userIdsGrantedDesign 本次被授予设计能力角色的用户集合
     */
    @Override
    public void assertGrantAllowed(long tenantId, List<Long> userIdsGrantedDesign) {
        if (seatLimit <= 0 || userIdsGrantedDesign == null || userIdsGrantedDesign.isEmpty()) {
            return;
        }
        LocalDate today = LocalDate.now();
        // 串行化锚点：锁当日快照行；无行先占位插入（0 值占位由后续 snapshot 校正）
        jdbc.update("""
                INSERT INTO seat_license_daily (tenant_id, stat_date, licensed_seats)
                VALUES (?, ?, 0) ON CONFLICT (tenant_id, stat_date) DO NOTHING
                """, tenantId, today);
        jdbc.queryForObject("""
                SELECT licensed_seats FROM seat_license_daily
                WHERE tenant_id = ? AND stat_date = ? FOR UPDATE
                """, Long.class, tenantId, today);
        long current = licensedSeats(tenantId);
        // 净新增 = 本次授予设计角色的用户中，当前不持任何设计能力角色的人数
        long netNew = userIdsGrantedDesign.stream()
                .filter(uid -> !holdsDesignRole(tenantId, uid))
                .count();
        if (current + netNew > seatLimit) {
            throw new BizException("SEAT_LIMIT_EXCEEDED", "新增设计能力角色超授权席位上限",
                    Map.of("licensedSeats", current, "limit", seatLimit));
        }
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
