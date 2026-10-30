package com.schema.metering.infrastructure.persistence;

import com.schema.metering.domain.UsageEventRecord;
import com.schema.metering.domain.repository.MeteringRepository;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Date;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 计量 JDBC 仓储（09BE §3/§5）。
 * 幂等：eventId 主键冲突跳过；聚合覆盖写（ON CONFLICT DO UPDATE）重跑安全。
 */
@Repository
public class JdbcMeteringRepository implements MeteringRepository {

    private final JdbcTemplate jdbc;

    public JdbcMeteringRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void insertEvent(UsageEventRecord r) {
        jdbc.update("""
                INSERT INTO usage_event (event_id, tenant_id, user_id, metric, quantity, app_id, source,
                                         occurred_at, received_at, attrs)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
                ON CONFLICT (event_id) DO NOTHING
                """,
                r.eventId(), r.tenantId(), r.userId(), r.metric(), r.quantity(), r.appId(), r.source(),
                r.occurredAt(), r.receivedAt(), r.attrsJson());
    }

    @Override
    public boolean eventExists(String eventId) {
        Long n = jdbc.queryForObject("SELECT COUNT(*) FROM usage_event WHERE event_id = ?", Long.class, eventId);
        return n != null && n > 0;
    }

    @Override
    public void aggregateDaily(LocalDate date) {
        // 计费口径常规指标：仅服务端行（09BE §4 计费一律服务端埋点；前端漏斗行不混计）
        jdbc.update("""
                INSERT INTO usage_daily (tenant_id, metric, stat_date, quantity, dims)
                SELECT tenant_id, metric, ?::date, SUM(quantity), NULL
                FROM usage_event WHERE occurred_at >= ? AND occurred_at < ? + 1
                  AND metric <> 'seat.active' AND source = 'SERVER'
                GROUP BY tenant_id, metric
                ON CONFLICT (tenant_id, metric, stat_date) DO UPDATE SET quantity = EXCLUDED.quantity
                """, date, date, date);
        // 前端漏斗指标独立聚合（dims 标注漏斗口径——只做观测不进出账）
        jdbc.update("""
                INSERT INTO usage_daily (tenant_id, metric, stat_date, quantity, dims)
                SELECT tenant_id, metric, ?::date, SUM(quantity), jsonb_build_object('source', 'FUNNEL')
                FROM usage_event WHERE occurred_at >= ? AND occurred_at < ? + 1
                  AND metric LIKE 'funnel.%'
                GROUP BY tenant_id, metric
                ON CONFLICT (tenant_id, metric, stat_date) DO UPDATE SET quantity = EXCLUDED.quantity,
                        dims = EXCLUDED.dims
                """, date, date, date);
        // seat.active：服务端终审去重人数（同用户 CLIENT+SERVER 双源只信 SERVER，09BE §5）
        jdbc.update("""
                INSERT INTO usage_daily (tenant_id, metric, stat_date, quantity, dims)
                SELECT tenant_id, 'seat.active', ?::date, COUNT(DISTINCT user_id),
                       jsonb_build_object('source', 'SERVER_FINAL')
                FROM usage_event
                WHERE occurred_at >= ? AND occurred_at < ? + 1 AND metric = 'seat.active'
                  AND source = 'SERVER' AND user_id IS NOT NULL
                GROUP BY tenant_id
                ON CONFLICT (tenant_id, metric, stat_date) DO UPDATE SET quantity = EXCLUDED.quantity,
                        dims = EXCLUDED.dims
                """, date, date, date);
    }

    @Override
    public List<Map<String, Object>> findDaily(long tenantId, String metric, LocalDate from, LocalDate to) {
        return jdbc.queryForList(
                "SELECT stat_date, quantity FROM usage_daily WHERE tenant_id = ? AND metric = ?"
                        + " AND stat_date >= ? AND stat_date <= ? ORDER BY stat_date",
                tenantId, metric, from, to);
    }

    @Override
    public long rollingActiveSeats(long tenantId, LocalDate today) {
        // 滚动 30 天活跃 = 服务端终审口径去重人数（窗口 [today-29, today]）
        Long n = jdbc.queryForObject("""
                SELECT COUNT(DISTINCT user_id) FROM usage_event
                WHERE tenant_id = ? AND metric = 'seat.active' AND source = 'SERVER' AND user_id IS NOT NULL
                  AND occurred_at::date >= ? AND occurred_at::date <= ?
                """, Long.class, tenantId, today.minusDays(29), today);
        return n == null ? 0L : n;
    }

    @Override
    public void upsertSeatSnapshot(long tenantId, LocalDate date, long licensedSeats) {
        jdbc.update("""
                INSERT INTO seat_license_daily (tenant_id, stat_date, licensed_seats)
                VALUES (?, ?, ?)
                ON CONFLICT (tenant_id, stat_date) DO UPDATE SET licensed_seats = EXCLUDED.licensed_seats
                """, tenantId, date, licensedSeats);
    }

    @Override
    public Optional<Long> latestLicensedSeats(long tenantId) {
        List<Long> rows = jdbc.query(
                "SELECT licensed_seats FROM seat_license_daily WHERE tenant_id = ? ORDER BY stat_date DESC LIMIT 1",
                (rs, i) -> rs.getLong(1), tenantId);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }
}
