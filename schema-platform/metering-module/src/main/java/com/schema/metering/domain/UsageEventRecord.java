package com.schema.metering.domain;

import com.schema.platform.common.json.Json;

import java.time.OffsetDateTime;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 用量事件聚合根（09BE §2-3）：
 * - 校验与归一化在领域层收口（合规白名单 / 时间归属 / 幂等键）；
 * - 明细与汇总分离：本聚合只产出明细行，聚合归 UsageAggregateService。
 */
public final class UsageEventRecord {

    private final String eventId;
    private final long tenantId;
    private final Long userId;
    private final String metric;
    private final long quantity;
    private final Long appId;
    private final String source;
    private final OffsetDateTime occurredAt;
    private final OffsetDateTime receivedAt;
    private final String attrsJson;

    private UsageEventRecord(String eventId, long tenantId, Long userId, String metric, long quantity,
            Long appId, String source, OffsetDateTime occurredAt, OffsetDateTime receivedAt, String attrsJson) {
        this.eventId = eventId;
        this.tenantId = tenantId;
        this.userId = userId;
        this.metric = metric;
        this.quantity = quantity;
        this.appId = appId;
        this.source = source;
        this.occurredAt = occurredAt;
        this.receivedAt = receivedAt;
        this.attrsJson = attrsJson;
    }

    /** 服务端埋点内部构造（recordServer 专用——绕过信封归一化直接落终审行）。 */
    public static UsageEventRecord serverRecord(String eventId, long tenantId, Long userId, String metric,
            long quantity, Long appId, OffsetDateTime occurredAt, String attrsJson) {
        return new UsageEventRecord(eventId, tenantId, userId, metric, quantity, appId, "SERVER",
                occurredAt, occurredAt, attrsJson);
    }

    /** 校验失败信息（含批量下标，09BE §A.1 整批 422 {invalidIndices[]}）。 */
    public record Invalid(int index, String reason) {}

    /**
     * 从上报信封归一化：违规收集到 invalid 列表由调用方决定整批拒绝。
     * 时间归属：occurred_at 超回溯窗口按 received_at 落日（§4 时间归属规则）。
     */
    public static UsageEventRecord normalize(int index, long tenantId, Long userId, Map<String, Object> env,
            OffsetDateTime receivedAt) {
        String reason = validateEnvelope(index, env);
        if (reason != null) {
            throw new IllegalArgumentException(reason);
        }
        String eventId = str(env.get("eventId"));
        String metric = str(env.get("metric"));
        long quantity = env.get("quantity") == null ? 1L : num(env.get("quantity"));
        OffsetDateTime occurred = parseTime(env.get("occurredAt"), receivedAt);
        // 超回溯窗口 → 按 received_at 归属（防跨月逃配额）
        if (occurred.isBefore(receivedAt.minus(MeteringPolicy.OCCURRED_BACKTRACK_HOURS, ChronoUnit.HOURS))) {
            occurred = receivedAt;
        }
        String source = env.get("source") == null ? "CLIENT" : str(env.get("source"));
        String attrsJson = env.get("attrs") == null ? null
                : Json.write(sortKeys(asMap(env.get("attrs"))));
        return new UsageEventRecord(eventId, tenantId, userId, metric, quantity,
                env.get("appId") == null ? null : numLong(env.get("appId")), source, occurred, receivedAt, attrsJson);
    }

    /** 信封静态校验（不构造即拒绝，违规信息带下标）。 */
    public static String validateEnvelope(int index, Map<String, Object> env) {
        if (env == null) {
            return "events[" + index + "]: 缺失";
        }
        String eventId = str(env.get("eventId"));
        if (eventId == null || eventId.isBlank() || eventId.length() > 64) {
            return "events[" + index + "]: eventId 非法（幂等键必填 ≤64）";
        }
        try {
            UUID.fromString(eventId);
        } catch (IllegalArgumentException e) {
            return "events[" + index + "]: eventId 非合法 UUID";
        }
        String metric = str(env.get("metric"));
        if (metric == null || !MeteringPolicy.METRICS.contains(metric)) {
            return "events[" + index + "]: metric 不在口径白名单";
        }
        Object q = env.get("quantity");
        if (q != null && (!(q instanceof Number) || ((Number) q).longValue() < 1)) {
            return "events[" + index + "]: quantity 必须为正整数";
        }
        // 合规白名单（§1 红线）：attrs 只允许白名单键 + 标量值
        Object attrs = env.get("attrs");
        if (attrs instanceof Map<?, ?> m) {
            for (Map.Entry<?, ?> e : m.entrySet()) {
                String key = String.valueOf(e.getKey());
                if (!MeteringPolicy.ATTR_KEYS.contains(key)) {
                    return "events[" + index + "]: attrs 含非白名单键 '" + key + "'（合规红线：禁止业务字段值）";
                }
                Object v = e.getValue();
                if (v == null) continue;
                if (v instanceof String s) {
                    if (s.length() > MeteringPolicy.MAX_STRING_LEN) {
                        return "events[" + index + "]: attrs." + key + " 超长（≤" + MeteringPolicy.MAX_STRING_LEN + "）";
                    }
                } else if (!(v instanceof Number || v instanceof Boolean)) {
                    return "events[" + index + "]: attrs." + key + " 必须为标量（ID/枚举/数值）";
                }
            }
        }
        return null;
    }

    private static String str(Object v) {
        return v == null ? null : String.valueOf(v);
    }

    private static long num(Object v) {
        return v instanceof Number n ? n.longValue() : Long.parseLong(String.valueOf(v));
    }

    private static Long numLong(Object v) {
        return v instanceof Number n ? n.longValue() : Long.parseLong(String.valueOf(v));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object v) {
        return (Map<String, Object>) v;
    }

    private static Map<String, Object> sortKeys(Map<String, Object> m) {
        List<String> keys = new ArrayList<>(m.keySet());
        keys.sort(String::compareTo);
        java.util.LinkedHashMap<String, Object> sorted = new java.util.LinkedHashMap<>();
        for (String k : keys) sorted.put(k, m.get(k));
        return sorted;
    }

    private static OffsetDateTime parseTime(Object v, OffsetDateTime fallback) {
        if (v == null) return fallback;
        try {
            return OffsetDateTime.parse(String.valueOf(v));
        } catch (Exception e) {
            return fallback;
        }
    }

    public String eventId() { return eventId; }
    public long tenantId() { return tenantId; }
    public Long userId() { return userId; }
    public String metric() { return metric; }
    public long quantity() { return quantity; }
    public Long appId() { return appId; }
    public String source() { return source; }
    public OffsetDateTime occurredAt() { return occurredAt; }
    public OffsetDateTime receivedAt() { return receivedAt; }
    public String attrsJson() { return attrsJson; }
}
