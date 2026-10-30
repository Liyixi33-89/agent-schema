package com.schema.metering.infrastructure.seats;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.util.List;

/**
 * 授权席位判定（13BE §2.4 唯一实现点；M8.4）：
 * COUNT(DISTINCT user) WHERE 任一应用角色 ∈ {应用管理员, 开发者}——授权即计（无论是否操作）。
 * 单租户 MVP：租户内跨应用聚合；并发控制（SELECT FOR UPDATE 席位行）随 M11.4 应用服务接入。
 */
@Component
public class LicensedSeatCalculator {

    /** 设计能力角色编码（授权即计席位，13BE §2.4）。 */
    public static final List<String> DESIGN_ROLE_CODES = List.of("app_admin", "developer");

    private final JdbcTemplate jdbc;

    public LicensedSeatCalculator(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
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
}
