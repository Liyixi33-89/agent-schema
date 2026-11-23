package com.schema.flow.infrastructure.persistence;

import com.schema.flow.domain.repository.FlowInstanceRepository;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 实例绑定 + 任务日志 JDBC 仓储（spec 021 §3.5）。
 */
@Repository
public class JdbcFlowInstanceRepository implements FlowInstanceRepository {

    private final JdbcTemplate jdbc;

    public JdbcFlowInstanceRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public long insert(String instanceId, long tenantId, long modelId, long recordId, long flowDefId,
            long startedBy, String status) {
        Long id = jdbc.queryForObject("""
                INSERT INTO flow_instance_biz
                    (instance_id, tenant_id, model_id, record_id, flow_def_id, started_by, status)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                RETURNING id
                """, Long.class, instanceId, tenantId, modelId, recordId, flowDefId, startedBy, status);
        return id == null ? 0L : id;
    }

    @Override
    public Optional<Map<String, Object>> findByInstanceId(long tenantId, String instanceId) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT * FROM flow_instance_biz WHERE tenant_id = ? AND instance_id = ?",
                tenantId, instanceId);
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    @Override
    public List<Map<String, Object>> findByBizRecord(long tenantId, long modelId, long recordId) {
        return jdbc.queryForList("""
                SELECT instance_id, flow_def_id, status, started_at
                FROM flow_instance_biz
                WHERE tenant_id = ? AND model_id = ? AND record_id = ?
                ORDER BY started_at DESC
                """, tenantId, modelId, recordId);
    }

    @Override
    public int updateStatus(long tenantId, String instanceId, String status) {
        return jdbc.update("""
                UPDATE flow_instance_biz SET status = ?
                WHERE tenant_id = ? AND instance_id = ?
                """, status, tenantId, instanceId);
    }

    @Override
    public void insertTaskLog(long tenantId, String taskId, String instanceId, String nodeId,
            String action, long operatorId, String comment, OffsetDateTime operatedAt) {
        jdbc.update("""
                INSERT INTO flow_task_log
                    (tenant_id, task_id, instance_id, node_id, action, operator_id, comment, operated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, tenantId, taskId, instanceId, nodeId, action, operatorId, comment, operatedAt);
    }

    @Override
    public List<Map<String, Object>> listTaskLogs(long tenantId, String instanceId) {
        return jdbc.queryForList("""
                SELECT task_id, node_id, action, operator_id, comment, operated_at
                FROM flow_task_log
                WHERE tenant_id = ? AND instance_id = ?
                ORDER BY operated_at ASC
                """, tenantId, instanceId);
    }
}