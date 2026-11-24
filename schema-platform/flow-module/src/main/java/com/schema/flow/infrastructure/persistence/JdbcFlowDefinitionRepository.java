package com.schema.flow.infrastructure.persistence;

import com.schema.flow.domain.repository.FlowDefinitionRepository;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 流程定义 JDBC 仓储（spec 021 §3.5）。
 */
@Repository
public class JdbcFlowDefinitionRepository implements FlowDefinitionRepository {

    private final JdbcTemplate jdbc;

    public JdbcFlowDefinitionRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public long insert(long tenantId, long appId, String flowKey, String name, String status,
            String flowSchemaJson, long createdBy) {
        Long id = jdbc.queryForObject("""
                INSERT INTO flow_definition
                    (tenant_id, app_id, flow_key, name, status, version, flow_schema, created_by)
                VALUES (?, ?, ?, ?, ?, 1, ?::jsonb, ?)
                RETURNING id
                """, Long.class, tenantId, appId, flowKey, name, status, flowSchemaJson, createdBy);
        return id == null ? 0L : id;
    }

    @Override
    public Optional<Map<String, Object>> findById(long tenantId, long id) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT * FROM flow_definition WHERE tenant_id = ? AND id = ?", tenantId, id);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    @Override
    public Optional<Map<String, Object>> findByKey(long tenantId, long appId, String flowKey) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT * FROM flow_definition WHERE tenant_id = ? AND app_id = ? AND flow_key = ?",
                tenantId, appId, flowKey);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    @Override
    public List<Map<String, Object>> listByApp(long tenantId, long appId) {
        return jdbc.queryForList("""
                SELECT id, name, flow_key, status, version, updated_at
                FROM flow_definition WHERE tenant_id = ? AND app_id = ?
                ORDER BY updated_at DESC
                """, tenantId, appId);
    }

    @Override
    public int updateDraft(long tenantId, long id, int baseVersion, String flowSchemaJson) {
        // 乐观锁：version 必须仍是 baseVersion（并发保存只有一个成功）
        return jdbc.update("""
                UPDATE flow_definition
                SET flow_schema = ?::jsonb, version = version + 1, updated_at = now()
                WHERE tenant_id = ? AND id = ? AND version = ?
                """, flowSchemaJson, tenantId, id, baseVersion);
    }

    @Override
    public int markPublished(long tenantId, long id, int expectedVersion, int nextVersion,
            String flowSchemaJson, String deploymentId) {
        return jdbc.update("""
                UPDATE flow_definition
                SET status = 'PUBLISHED', version = ?, flow_schema = ?::jsonb,
                    deployment_id = ?, updated_at = now()
                WHERE tenant_id = ? AND id = ? AND version = ?
                """, nextVersion, flowSchemaJson, deploymentId, tenantId, id, expectedVersion);
    }
}