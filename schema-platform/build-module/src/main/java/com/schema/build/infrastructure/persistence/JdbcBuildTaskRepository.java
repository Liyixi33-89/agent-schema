package com.schema.build.infrastructure.persistence;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * build_task 仓储（04BE §2.4）：任务落库 + 同源码幂等查询。
 * 幂等语义：同 (tenantId, sourceHash) 的 SUCCESS 任务直接复用产物（不产生新对象）。
 */
@Component
public class JdbcBuildTaskRepository {

    private final JdbcTemplate jdbc;

    public JdbcBuildTaskRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 同源码成功任务复用（返回 contentHash；无则 null）。 */
    public String findSuccessHash(long tenantId, String sourceHash) {
        var list = jdbc.queryForList(
                "SELECT content_hash FROM build_task WHERE tenant_id = ? AND source_hash = ? AND status = 'SUCCESS' LIMIT 1",
                String.class, tenantId, sourceHash);
        return list.isEmpty() ? null : list.get(0);
    }

    public long insert(long tenantId, Long appId, Long pageId, String sourceHash, String contentHash,
            String status, String errorsJson, int durationMs, Long createdBy) {
        return jdbc.queryForObject(
                """
                INSERT INTO build_task (tenant_id, app_id, page_id, source_hash, content_hash, status, errors, duration_ms, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?) RETURNING id
                """,
                Long.class, tenantId, appId, pageId, sourceHash, contentHash, status,
                errorsJson, durationMs, createdBy);
    }

    public Map<String, Object> findById(long tenantId, long taskId) {
        var list = jdbc.queryForList(
                "SELECT id, status, content_hash, errors, duration_ms, created_at FROM build_task WHERE id = ? AND tenant_id = ?",
                taskId, tenantId);
        return list.isEmpty() ? null : list.get(0);
    }
}
