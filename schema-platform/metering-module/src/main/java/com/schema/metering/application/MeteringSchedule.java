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

    /** 每日 03:00（本地时区）聚合前一日 + 当日席位快照。 */
    @Scheduled(cron = "0 0 3 * * *")
    public void dailyAggregate() {
        LocalDate yesterday = LocalDate.now().minusDays(1);
        metering.aggregate(yesterday);
        // 迟到数据兜底（09BE §4 T+3 天补算）：顺带重跑昨日窗口已覆盖，幂等安全
        snapshotAllTenants(LocalDate.now());
    }

    /** 全租户授权席位快照（13BE §2.4 每日快照；单机 MVP 全量遍历）。 */
    public void snapshotAllTenants(LocalDate date) {
        List<Map<String, Object>> tenants = jdbc.queryForList(
                "SELECT DISTINCT tenant_id FROM sys_user_role ur JOIN sys_role r ON r.id = ur.role_id");
        for (Map<String, Object> t : tenants) {
            long tenantId = ((Number) t.get("tenant_id")).longValue();
            seats.snapshot(tenantId, date);
        }
    }
}
