package com.schema.file.domain.repository;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 文件仓储接口（DIP）。
 */
public interface FileRepository {

    /** PENDING 登记后返回 fileId（objectKey 由 updateObjectKey 回填——依赖 DB 生成的主键）。 */
    long insertPending(long tenantId, Long appId, String scope, String fileName,
            String contentType, long sizeBytes, Long uploadedBy);

    void updateObjectKey(long fileId, String objectKey);

    void markActive(long fileId, String sha256);

    void markExpired(long fileId);

    Optional<Map<String, Object>> findById(long tenantId, long fileId);

    /** 生命周期：PENDING 超时清理候选（11BE §5）。 */
    List<Map<String, Object>> findStalePending(java.time.OffsetDateTime before, int limit);

    /** 分块会话。 */
    void saveMultipart(long fileId, String uploadId, long partSize, int totalParts);

    void appendUploadedPart(long fileId, int partNumber);

    Optional<Map<String, Object>> findMultipart(long fileId);

    /** 租户存储用量（storage.gb 计量源，11BE §5）。 */
    long sumActiveBytes(long tenantId);
}
