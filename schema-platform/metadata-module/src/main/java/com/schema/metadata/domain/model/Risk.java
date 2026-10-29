package com.schema.metadata.domain.model;

import java.util.List;
import java.util.Map;

/**
 * 影响面风险（01BE §4.2/§4.5）：
 * type: PAGE_REF / FLOW_REF / SCRIPT_REF / API_CONSUMER / DATA_VOLUME；
 * severity: HIGH / MEDIUM / INFO。
 */
public record Risk(String type, Long refId, String refName, String keyName, Long calls30d,
        Long count, String severity) {

    public static final String HIGH = "HIGH";
    public static final String MEDIUM = "MEDIUM";
    public static final String INFO = "INFO";

    public static int rank(String severity) {
        return switch (severity) {
            case HIGH -> 3;
            case MEDIUM -> 2;
            default -> 1;
        };
    }

    /** 构造 Map 形态（仓储/接口层复用）。 */
    public Map<String, Object> toMap() {
        Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("type", type);
        if (refId != null) m.put("refId", refId);
        if (refName != null) m.put("refName", refName);
        if (keyName != null) m.put("keyName", keyName);
        if (calls30d != null) m.put("calls30d", calls30d);
        if (count != null) m.put("count", count);
        m.put("severity", severity);
        return m;
    }

    @SuppressWarnings("unchecked")
    public static Risk fromMap(Map<String, Object> m) {
        return new Risk(
                (String) m.get("type"),
                m.get("refId") instanceof Number n ? n.longValue() : null,
                (String) m.get("refName"),
                (String) m.get("keyName"),
                m.get("calls30d") instanceof Number n ? n.longValue() : null,
                m.get("count") instanceof Number n ? n.longValue() : null,
                (String) m.get("severity"));
    }

    public static String maxSeverity(List<Risk> risks) {
        String max = INFO;
        for (Risk r : risks) {
            if (rank(r.severity) > rank(max)) {
                max = r.severity;
            }
        }
        return max;
    }
}
