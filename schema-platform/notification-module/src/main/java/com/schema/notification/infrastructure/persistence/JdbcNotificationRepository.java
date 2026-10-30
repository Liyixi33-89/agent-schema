package com.schema.notification.infrastructure.persistence;

import com.schema.notification.domain.repository.NotificationRepository;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 通知 JDBC 仓储（12BE §2）。
 * 频控用 PG 行级原子 UPSERT 实现 TTL 窗口计数（Redis 本地不可用的降级——单机语义一致）。
 */
@Repository
public class JdbcNotificationRepository implements NotificationRepository {

    private final JdbcTemplate jdbc;

    public JdbcNotificationRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public long insert(long tenantId, String bizType, String bizRefId, long recipientId, String templateKey,
            String renderedJson, String channelsJson, String status, String suppressReason,
            OffsetDateTime occurredAt) {
        Long id = jdbc.queryForObject("""
                INSERT INTO notify_message (tenant_id, biz_type, biz_ref_id, recipient_id, template_key,
                                            rendered, channels, status, suppress_reason, occurred_at)
                VALUES (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?)
                RETURNING id
                """, Long.class, tenantId, bizType, bizRefId, recipientId, templateKey,
                renderedJson, channelsJson, status, suppressReason, occurredAt);
        return id == null ? 0L : id;
    }

    @Override
    public Optional<Map<String, Object>> findById(long tenantId, long id) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT * FROM notify_message WHERE tenant_id = ? AND id = ?", tenantId, id);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    @Override
    public List<Map<String, Object>> list(long tenantId, long recipientId, boolean unreadOnly,
            String bizType, int page, int size) {
        // 用户视图只含可投递消息：SUPPRESSED 仅审计可见（12BE §5 留痕不出箱）
        StringBuilder sql = new StringBuilder(
                "SELECT * FROM notify_message WHERE tenant_id = ? AND recipient_id = ? AND status <> 'SUPPRESSED'");
        java.util.List<Object> args = new java.util.ArrayList<>(List.of(tenantId, recipientId));
        if (unreadOnly) {
            sql.append(" AND read_at IS NULL");
        }
        if (bizType != null && !bizType.isBlank()) {
            sql.append(" AND biz_type = ?");
            args.add(bizType);
        }
        sql.append(" ORDER BY created_at DESC LIMIT ? OFFSET ?");
        args.add(size);
        args.add((long) page * size);
        return jdbc.queryForList(sql.toString(), args.toArray());
    }

    @Override
    public long count(long tenantId, long recipientId, boolean unreadOnly) {
        return count(tenantId, recipientId, unreadOnly, null);
    }

    @Override
    public long count(long tenantId, long recipientId, boolean unreadOnly, String bizType) {
        // 未读/总数均不含 SUPPRESSED——抑制消息不得进入红点（同 list 过滤）
        StringBuilder sql = new StringBuilder(
                "SELECT COUNT(*) FROM notify_message WHERE tenant_id = ? AND recipient_id = ? AND status <> 'SUPPRESSED'");
        java.util.List<Object> args = new java.util.ArrayList<>(List.of(tenantId, recipientId));
        if (unreadOnly) {
            sql.append(" AND read_at IS NULL");
        }
        if (bizType != null && !bizType.isBlank()) {
            sql.append(" AND biz_type = ?");
            args.add(bizType);
        }
        Long n = jdbc.queryForObject(sql.toString(), Long.class, args.toArray());
        return n == null ? 0L : n;
    }

    @Override
    public void markRead(long tenantId, long recipientId, long id, OffsetDateTime readAt) {
        // 收件人绑定：只能标记自己的消息（同租户他人消息 0 行更新——不给越权线索）
        jdbc.update("""
                UPDATE notify_message SET read_at = COALESCE(read_at, ?)
                WHERE tenant_id = ? AND recipient_id = ? AND id = ? AND status <> 'SUPPRESSED'
                """, readAt, tenantId, recipientId, id);
    }

    @Override
    public void markAllRead(long tenantId, long recipientId, OffsetDateTime readAt) {
        jdbc.update("""
                UPDATE notify_message SET read_at = ?
                WHERE tenant_id = ? AND recipient_id = ? AND read_at IS NULL
                """, readAt, tenantId, recipientId);
    }

    @Override
    public int markAllReadReturning(long tenantId, long recipientId) {
        // 全部已读只作用于用户可见集（SUPPRESSED 不被触碰——保持审计原貌）
        return jdbc.update("""
                UPDATE notify_message SET read_at = now()
                WHERE tenant_id = ? AND recipient_id = ? AND read_at IS NULL AND status <> 'SUPPRESSED'
                """, tenantId, recipientId);
    }

    @Override
    public Optional<Map<String, Object>> findPref(long tenantId, long userId) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT prefs FROM notify_user_pref WHERE tenant_id = ? AND user_id = ?", tenantId, userId);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    @Override
    public void upsertPref(long tenantId, long userId, String prefsJson) {
        jdbc.update("""
                INSERT INTO notify_user_pref (tenant_id, user_id, prefs)
                VALUES (?, ?, ?::jsonb)
                ON CONFLICT (tenant_id, user_id) DO UPDATE SET prefs = EXCLUDED.prefs
                """, tenantId, userId, prefsJson);
    }

    @Override
    public List<Map<String, Object>> listTemplates(long tenantId) {
        return jdbc.queryForList(
                "SELECT key, title, body, vars_schema FROM notify_template WHERE tenant_id = ? ORDER BY key",
                tenantId);
    }

    @Override
    public Optional<Map<String, Object>> findTemplate(long tenantId, String key) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT key, title, body, vars_schema FROM notify_template WHERE tenant_id = ? AND key = ?",
                tenantId, key);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    @Override
    public void insertTemplate(long tenantId, String key, String title, String body, String varsSchemaJson) {
        jdbc.update("""
                INSERT INTO notify_template (tenant_id, key, title, body, vars_schema)
                VALUES (?, ?, ?, ?, ?::jsonb)
                """, tenantId, key, title, body, varsSchemaJson);
    }

    @Override
    public int bumpRate(String rateKey, int windowSeconds) {
        // 原子窗口计数：窗口过期重置为 1；窗口内递增（12BE §5 SUPPRESS 判定输入）
        Integer n = jdbc.queryForObject("""
                INSERT INTO notify_rate_window (rate_key, window_start, count)
                VALUES (?, now(), 1)
                ON CONFLICT (rate_key) DO UPDATE SET
                    count = CASE WHEN notify_rate_window.window_start < now() - (? || ' seconds')::interval
                                 THEN 1 ELSE notify_rate_window.count + 1 END,
                    window_start = CASE WHEN notify_rate_window.window_start < now() - (? || ' seconds')::interval
                                 THEN now() ELSE notify_rate_window.window_start END
                RETURNING count
                """, Integer.class, rateKey, String.valueOf(windowSeconds), String.valueOf(windowSeconds));
        return n == null ? 0 : n;
    }
}
