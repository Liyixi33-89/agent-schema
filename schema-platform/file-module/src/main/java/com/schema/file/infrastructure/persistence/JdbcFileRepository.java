package com.schema.file.infrastructure.persistence;

import com.schema.file.domain.repository.FileRepository;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Array;
import java.sql.Connection;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 文件 JDBC 仓储（11BE §4）。
 */
@Repository
public class JdbcFileRepository implements FileRepository {

    private final JdbcTemplate jdbc;

    public JdbcFileRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public long insertPending(long tenantId, Long appId, String scope, String fileName,
            String contentType, long sizeBytes, Long uploadedBy) {
        return jdbc.queryForObject("""
                INSERT INTO file_object (tenant_id, app_id, scope, object_key, file_name, content_type,
                                         size_bytes, status, uploaded_by)
                VALUES (?, ?, ?, '', ?, ?, ?, 'PENDING', ?)
                RETURNING id
                """, Long.class, tenantId, appId, scope, fileName, contentType, sizeBytes, uploadedBy);
    }

    @Override
    public void updateObjectKey(long fileId, String objectKey) {
        jdbc.update("UPDATE file_object SET object_key = ? WHERE id = ?", objectKey, fileId);
    }

    @Override
    public void markActive(long fileId, String sha256) {
        jdbc.update("UPDATE file_object SET status = 'ACTIVE', sha256 = ? WHERE id = ?", sha256, fileId);
    }

    @Override
    public void markExpired(long fileId) {
        jdbc.update("UPDATE file_object SET status = 'EXPIRED' WHERE id = ?", fileId);
    }

    @Override
    public Optional<Map<String, Object>> findById(long tenantId, long fileId) {
        // 同租户过滤（跨租户同响应不给线索——FILE_NOT_FOUND 语义）
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT * FROM file_object WHERE tenant_id = ? AND id = ?", tenantId, fileId);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    @Override
    public List<Map<String, Object>> findStalePending(OffsetDateTime before, int limit) {
        return jdbc.queryForList(
                "SELECT * FROM file_object WHERE status = 'PENDING' AND created_at < ? ORDER BY id LIMIT ?",
                before, limit);
    }

    @Override
    public void saveMultipart(long fileId, String uploadId, long partSize, int totalParts) {
        jdbc.update("""
                INSERT INTO file_multipart_session (file_id, upload_id, part_size, total_parts, uploaded_parts)
                VALUES (?, ?, ?, ?, '{}')
                """, fileId, uploadId, partSize, totalParts);
    }

    @Override
    public void appendUploadedPart(long fileId, int partNumber) {
        // int[] 列用原生数组追加（JdbcTemplate 无数组参数——conn 级操作）
        jdbc.update(conn -> {
            Array updated = toArrayWith(conn, fileId, partNumber);
            var ps = conn.prepareStatement(
                    "UPDATE file_multipart_session SET uploaded_parts = ? WHERE file_id = ?");
            ps.setArray(1, updated);
            ps.setLong(2, fileId);
            return ps;
        });
    }

    private Array toArrayWith(Connection conn, long fileId, int partNumber) throws java.sql.SQLException {
        Optional<Map<String, Object>> row = findMultipart(fileId);
        List<Integer> parts = new ArrayList<>();
        if (row.isPresent() && row.get().get("uploaded_parts") != null) {
            java.sql.Array arr = (java.sql.Array) row.get().get("uploaded_parts");
            Object[] raw = (Object[]) arr.getArray();
            for (Object o : raw) {
                parts.add(((Number) o).intValue());
            }
        }
        if (!parts.contains(partNumber)) {
            parts.add(partNumber);
        }
        return conn.createArrayOf("int", parts.toArray(new Integer[0]));
    }

    @Override
    @SuppressWarnings("unchecked")
    public Optional<Map<String, Object>> findMultipart(long fileId) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT * FROM file_multipart_session WHERE file_id = ?", fileId);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    @Override
    public long sumActiveBytes(long tenantId) {
        Long n = jdbc.queryForObject(
                "SELECT COALESCE(SUM(size_bytes), 0) FROM file_object WHERE tenant_id = ? AND status = 'ACTIVE'",
                Long.class, tenantId);
        return n == null ? 0L : n;
    }
}
