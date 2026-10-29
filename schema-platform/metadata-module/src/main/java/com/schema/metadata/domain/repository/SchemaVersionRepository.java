package com.schema.metadata.domain.repository;

import java.util.List;
import java.util.Map;

/**
 * 版本快照仓储（meta_schema_version，01BE §4.4）。
 */
public interface SchemaVersionRepository {

    record VersionSnapshot(long modelId, int version, String snapshotJson, String diffJson,
            long operatorId, java.time.OffsetDateTime createdAt, Integer rollbackFrom) {
    }

    void insertSnapshot(VersionSnapshot snapshot);

    List<VersionSnapshot> listVersions(long modelId, int limit);

    java.util.Optional<VersionSnapshot> findVersion(long modelId, int version);

    /** confirmToken 存储（01BE §4.2 签发与消费规则）。 */
    void issueToken(String token, long modelId, String bindingHash, int baseVersion,
            String confirmMode, java.time.OffsetDateTime expiresAt);

    /** 一次性消费：未过期且未消费才成功（CAS：consumed_at IS NULL → now）。 */
    boolean consumeToken(String token, String bindingHash, int baseVersion);

    /** 读取 token 签发时的 confirmMode（不存在/已过期返回 empty）。 */
    java.util.Optional<String> findTokenMode(String token);

    void purgeExpiredTokens();

    /** 引用登记（01BE §4.5）：upsert meta_field_reference。 */
    void upsertReference(long tenantId, long modelId, String fieldKey, String refType, long refId);

    /** 按字段聚合引用（影响面主路径）。 */
    List<Map<String, Object>> findReferences(long tenantId, long modelId, List<String> fieldKeys);

    /** 计算字段引用（COMPUTED）：登记到引用表。 */
    void upsertComputedReferences(long tenantId, long modelId, String computedFieldKey,
            List<String> dependsOn);
}
