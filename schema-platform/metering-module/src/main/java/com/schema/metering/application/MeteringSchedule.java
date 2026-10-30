package com.schema.metering.application;

import com.schema.metering.infrastructure.seats.LicensedSeatCalculator;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

/**
 * 计量定时任务（09BE §5 每日 T+1 03:00 跑前一日聚合；13BE §2.4 每日快照）。
 * 幂等：聚合覆盖写可重跑；快照 UPSERT 同日覆盖。
 */
@Component
public class MeteringSchedule {

    private final MeteringEventService metering;
    private final LicensedSeatCalculator seats;
    private final JdbcTemplate jdbc;

    public MeteringSchedule(MeteringEventService metering, LicensedSeatCalculator seats, JdbcTemplate jdbc) {
        this.metering = metering;
        this.seats = seats;
        this.jdbc = jdbc;
    }

    /**
     * 每日 03:00（本地时区）聚合前一日 + 当日席位快照。
     * 迟到数据兜底（09BE §4 T+3 补算）：重跑 D-1/D-2/D-3 三个窗口（幂等覆盖写）——
     * 此前只重跑 D-1，迟到事件（D-2/D-3 到账）无补算机会。
     */
    @Scheduled(cron = "0 0 3 * * *")
    public void dailyAggregate() {
        LocalDate today = LocalDate.now();
        for (int back = 1; back <= 3; back++) {
            metering.aggregate(today.minusDays(back));
        }
        snapshotAllTenants(today);
    }

    /**
     * 全租户授权席位快照（13BE §2.4 每日快照；单机 MVP 全量遍历）。
     * 遍历源 = 快照表历史租户 ∪ 当前持角色租户——无角色租户（角色已全部撤销）
     * 也要写 0 值快照，否则残留旧席位数造成多计。
     */
    public void snapshotAllTenants(LocalDate date) {
        java.util.Set<Long> tenantIds = new java.util.HashSet<>();
        for (Map<String, Object> t : jdbc.queryForList(
                "SELECT DISTINCT tenant_id FROM sys_user_role ur JOIN sys_role r ON r.id = ur.role_id")) {
            tenantIds.add(((Number) t.get("tenant_id")).longValue());
        }
        for (Map<String, Object> t : jdbc.queryForList(
                "SELECT DISTINCT tenant_id FROM seat_license_daily")) {
            tenantIds.add(((Number) t.get("tenant_id")).longValue());
        }
        for (Long tenantId : tenantIds) {
            seats.snapshot(tenantId, date);
        }
    }
}
