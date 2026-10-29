package com.schema.page.infrastructure.persistence;

import com.schema.page.domain.repository.PreviewGrantRepository;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 预览凭证仓储实现（04BE §A.7）。
 * grant 一次性消费 = 条件 UPDATE 行数判定（防 TOCTOU）；会话吊销 = revoked_at 置位。
 */
@Repository
public class JdbcPreviewGrantRepository implements PreviewGrantRepository {

    private final JdbcTemplate jdbc;

    public JdbcPreviewGrantRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static final java.sql.Timestamp ts(OffsetDateTime t) {
        return java.sql.Timestamp.from(t.toInstant());
    }

    @Override
    public long insertGrant(long tenantId, long appId, Long pageId, String grantUuid, long issuerId,
            boolean allowRealWrite, OffsetDateTime expiresAt) {
        jdbc.update("""
                INSERT INTO page_preview_grant (tenant_id, app_id, page_id, grant_uuid, issuer_id,
                  allow_real_write, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """, tenantId, appId, pageId, grantUuid, issuerId, allowRealWrite, ts(expiresAt));
        return jdbc.queryForObject("SELECT id FROM page_preview_grant WHERE grant_uuid=?", Long.class, grantUuid);
    }

    @Override
    public Optional<Grant> findGrant(String grantUuid) {
        List<Grant> rows = jdbc.query(
                "SELECT * FROM page_preview_grant WHERE grant_uuid=?",
                (rs, i) -> new Grant(rs.getLong("id"), rs.getLong("tenant_id"), rs.getLong("app_id"),
                        rs.getObject("page_id") instanceof Number n ? n.longValue() : null,
                        rs.getString("grant_uuid"), rs.getLong("issuer_id"), rs.getBoolean("allow_real_write"),
                        toOdt(rs.getTimestamp("expires_at")), toOdt(rs.getTimestamp("consumed_at"))),
                grantUuid);
        return rows.stream().findFirst();
    }

    @Override
    public boolean consumeGrant(String grantUuid) {
        // 一次性消费：未消费且未过期才置 consumed_at（并发交换恰一次成功）
        return jdbc.update("""
                UPDATE page_preview_grant SET consumed_at=now()
                WHERE grant_uuid=? AND consumed_at IS NULL AND expires_at>now()
                """, grantUuid) == 1;
    }

    @Override
    public int revokeUnusedGrants(long tenantId, long appId) {
        return jdbc.update("""
                UPDATE page_preview_grant SET consumed_at=now()
                WHERE tenant_id=? AND app_id=? AND consumed_at IS NULL AND expires_at>now()
                """, tenantId, appId);
    }

    @Override
    public long insertSession(long tenantId, long appId, Long pageId, String sessionUuid, long grantId,
            long issuerId, boolean allowRealWrite, OffsetDateTime expiresAt) {
        jdbc.update("""
                INSERT INTO page_preview_session (tenant_id, app_id, page_id, session_uuid, grant_id,
                  issuer_id, allow_real_write, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, tenantId, appId, pageId, sessionUuid, grantId, issuerId, allowRealWrite, ts(expiresAt));
        return jdbc.queryForObject("SELECT id FROM page_preview_session WHERE session_uuid=?", Long.class, sessionUuid);
    }

    @Override
    public Optional<Session> findSession(String sessionUuid) {
        List<Session> rows = jdbc.query(
                "SELECT * FROM page_preview_session WHERE session_uuid=?",
                (rs, i) -> new Session(rs.getLong("id"), rs.getLong("tenant_id"), rs.getLong("app_id"),
                        rs.getObject("page_id") instanceof Number n ? n.longValue() : null,
                        rs.getString("session_uuid"), rs.getLong("grant_id"), rs.getLong("issuer_id"),
                        rs.getBoolean("allow_real_write"),
                        toOdt(rs.getTimestamp("expires_at")), toOdt(rs.getTimestamp("revoked_at"))),
                sessionUuid);
        return rows.stream().findFirst();
    }

    @Override
    public boolean revokeSession(long tenantId, String sessionUuid) {
        return jdbc.update("""
                UPDATE page_preview_session SET revoked_at=now()
                WHERE session_uuid=? AND tenant_id=? AND revoked_at IS NULL AND expires_at>now()
                """, sessionUuid, tenantId) == 1;
    }

    @Override
    public int revokeSessionsOfApp(long tenantId, long appId) {
        return jdbc.update("""
                UPDATE page_preview_session SET revoked_at=now()
                WHERE tenant_id=? AND app_id=? AND revoked_at IS NULL AND expires_at>now()
                """, tenantId, appId);
    }

    @Override
    public List<Map<String, Object>> listActiveSessions(long tenantId, long appId) {
        return jdbc.queryForList(
                "SELECT session_uuid, page_id, expires_at FROM page_preview_session "
                        + "WHERE tenant_id=? AND app_id=? AND revoked_at IS NULL AND expires_at>now()",
                tenantId, appId);
    }

    private static OffsetDateTime toOdt(java.sql.Timestamp ts) {
        return ts != null ? ts.toInstant().atOffset(OffsetDateTime.now().getOffset()) : null;
    }
}
