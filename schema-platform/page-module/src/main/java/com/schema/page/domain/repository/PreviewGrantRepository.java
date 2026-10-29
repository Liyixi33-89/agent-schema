package com.schema.page.domain.repository;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 预览凭证仓储（04BE §A.7）：grant 一次性消费 + 会话吊销闭环。
 * 本地无 Redis：库表条件 UPDATE 语义等价（一次性语义靠条件更新行数，不靠先查后改）。
 */
public interface PreviewGrantRepository {

    record Grant(long id, long tenantId, long appId, Long pageId, String grantUuid, long issuerId,
            boolean allowRealWrite, OffsetDateTime expiresAt, OffsetDateTime consumedAt) {
        public boolean usable() {
            return consumedAt == null && expiresAt != null && expiresAt.isAfter(OffsetDateTime.now());
        }
    }

    record Session(long id, long tenantId, long appId, Long pageId, String sessionUuid, long grantId,
            long issuerId, boolean allowRealWrite, OffsetDateTime expiresAt, OffsetDateTime revokedAt) {
        public boolean active() {
            return revokedAt == null && expiresAt != null && expiresAt.isAfter(OffsetDateTime.now());
        }
    }

    long insertGrant(long tenantId, long appId, Long pageId, String grantUuid, long issuerId,
            boolean allowRealWrite, OffsetDateTime expiresAt);

    Optional<Grant> findGrant(String grantUuid);

    /** exchange 一次性消费（04BE §A.7：换取后 grant 立即失效；并发交换恰一次成功）。 */
    boolean consumeGrant(String grantUuid);

    /** 吊销该应用全部未用 grant，返回吊销数。 */
    int revokeUnusedGrants(long tenantId, long appId);

    long insertSession(long tenantId, long appId, Long pageId, String sessionUuid, long grantId,
            long issuerId, boolean allowRealWrite, OffsetDateTime expiresAt);

    Optional<Session> findSession(String sessionUuid);

    /** 单会话吊销（下一请求即 401 PREVIEW_SESSION_REVOKED）。 */
    boolean revokeSession(long tenantId, String sessionUuid);

    /** 吊销该应用全部在途会话，返回吊销数。 */
    int revokeSessionsOfApp(long tenantId, long appId);

    List<Map<String, Object>> listActiveSessions(long tenantId, long appId);
}
