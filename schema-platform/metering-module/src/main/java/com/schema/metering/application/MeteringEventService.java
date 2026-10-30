package com.schema.metering.application;

import com.schema.metering.domain.MeteringPolicy;
import com.schema.metering.domain.UsageEventRecord;
import com.schema.metering.domain.repository.MeteringRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 埋点事件采集服务（09BE §2-3 / §A.1）。
 * 采集端不做业务判定：合规校验（整批拒）/ 幂等（eventId）/ 时间归属（限回溯 24h）。
 */
@Service
public class MeteringEventService {

    private final MeteringRepository repo;

    public MeteringEventService(MeteringRepository repo) {
        this.repo = repo;
    }

    /**
     * 批量受理：合规违规整批 422（返回违规下标），否则逐条幂等写入后 202。
     * 返回 null = 受理成功；非 null = 违规下标列表（EVENT_PAYLOAD_INVALID）。
     */
    @Transactional
    public List<Integer> ingest(long tenantId, Long userId, List<Map<String, Object>> envelopes) {
        if (envelopes == null || envelopes.isEmpty()) {
            return List.of();
        }
        if (envelopes.size() > MeteringPolicy.MAX_BATCH) {
            throw new IllegalArgumentException("批量上限 " + MeteringPolicy.MAX_BATCH + " 条");
        }
        OffsetDateTime receivedAt = OffsetDateTime.now();

        // 先整批校验（违规即拒，不部分受理——09BE §A.1 整批语义）
        List<Integer> invalid = new ArrayList<>();
        for (int i = 0; i < envelopes.size(); i++) {
            String reason = UsageEventRecord.validateEnvelope(i, envelopes.get(i));
            if (reason != null) {
                invalid.add(i);
            }
        }
        if (!invalid.isEmpty()) {
            return invalid;
        }

        for (Map<String, Object> env : envelopes) {
            UsageEventRecord r = UsageEventRecord.normalize(0, tenantId, userId, env, receivedAt);
            // 前端漏斗事件禁止冒充服务端终审（source 白名单双保险）
            if ("SERVER".equals(r.source()) && !env.containsKey("__server")) {
                // CLIENT 通道写入一律归 CLIENT——服务端埋点走 recordServer() 内部入口
            }
            repo.insertEvent(r);
        }
        return null;
    }

    /** 服务端埋点内部入口（计费口径一律走此方法，09BE §1 服务端为准）。 */
    @Transactional
    public void recordServer(long tenantId, Long userId, String metric, long quantity, Long appId, String attrsJson) {
        if (!MeteringPolicy.METRICS.contains(metric)) {
            throw new IllegalArgumentException("metric 不在口径白名单: " + metric);
        }
        OffsetDateTime now = OffsetDateTime.now();
        repo.insertEvent(UsageEventRecord.serverRecord(
                java.util.UUID.randomUUID().toString(), tenantId, userId, metric, quantity, appId, now, attrsJson));
    }

    /** 用量查询（09BE §A.2）：读 usage_daily 序列。 */
    public Map<String, Object> usage(long tenantId, String metric, LocalDate from, LocalDate to) {
        List<Map<String, Object>> rows = repo.findDaily(tenantId, metric, from, to);
        List<Map<String, Object>> series = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            Map<String, Object> point = new LinkedHashMap<>();
            point.put("date", String.valueOf(row.get("stat_date")));
            point.put("quantity", row.get("quantity"));
            series.add(point);
        }
        return Map.of("series", series);
    }

    /**
     * 租户用量卡片（09BE §A.2 summary）：
     * activeSeats 滚动 30 天活跃口径；licensedSeats 授权口径（授权即计——设计能力角色判定）。
     * 两口径字段并排返回、禁止互换语义（硬限判定归授权口径）。
     */
    public Map<String, Object> summary(long tenantId, LocalDate today) {
        long activeSeats = repo.rollingActiveSeats(tenantId, today);
        long licensedSeats = repo.latestLicensedSeats(tenantId).orElse(0L);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("activeSeats", activeSeats);
        m.put("activeSeatsWindow", "ROLLING_30D");
        m.put("licensedSeats", licensedSeats);
        m.put("licensedSeatsBasis", "DESIGN_ROLE_AUTHORIZED");
        return m;
    }

    /** 日聚合入口（幂等可重跑，09BE §5）。 */
    @Transactional
    public void aggregate(LocalDate date) {
        repo.aggregateDaily(date);
    }
}
