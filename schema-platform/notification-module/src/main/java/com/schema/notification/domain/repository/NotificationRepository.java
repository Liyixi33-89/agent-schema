package com.schema.notification.domain.repository;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 通知仓储接口（DIP）。
 */
public interface NotificationRepository {

    long insert(long tenantId, String bizType, String bizRefId, long recipientId, String templateKey,
            String renderedJson, String channelsJson, String status, OffsetDateTime occurredAt);

    Optional<Map<String, Object>> findById(long tenantId, long id);

    List<Map<String, Object>> list(long tenantId, long recipientId, boolean unreadOnly,
            String bizType, int page, int size);

    long count(long tenantId, long recipientId, boolean unreadOnly);

    void markRead(long tenantId, long id, OffsetDateTime readAt);

    void markAllRead(long tenantId, long recipientId, OffsetDateTime readAt);

    /** 全部已读并返回更新行数。 */
    int markAllReadReturning(long tenantId, long recipientId);

    // ---------- 偏好 ----------

    Optional<Map<String, Object>> findPref(long tenantId, long userId);

    void upsertPref(long tenantId, long userId, String prefsJson);

    // ---------- 模板（应用自定义） ----------

    List<Map<String, Object>> listTemplates(long tenantId);

    Optional<Map<String, Object>> findTemplate(long tenantId, String key);

    void insertTemplate(long tenantId, String key, String title, String body, String varsSchemaJson);

    // ---------- 频控（窗口计数本地降级实现，12BE §5） ----------

    /** 原子计数：窗口内第 N 次递增（返回递增后计数）；窗口过期则重置为 1。 */
    int bumpRate(String rateKey, int windowSeconds);
}
