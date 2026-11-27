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

    /**
     * 记录实例执行时的流程定义版本（2026-11-27 评审修复）。
     *
     * 单独一条 UPDATE 而不是塞进 insert：insert 是既有接口（多处调用），
     * 改签名会波及测试；且版本只在发起路径需要，语义上是「发起后补记」。
     */
    @Override
    public void recordDefVersion(long tenantId, String instanceId, Integer defVersion) {
        if (defVersion == null) return;
        jdbc.update("UPDATE flow_instance_biz SET flow_def_version = ? "
                + "WHERE tenant_id = ? AND instance_id = ?", defVersion, tenantId, instanceId);
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

    /**
     * 我办理过的任务（T5 已办）。
     *
     * 关联 flow_instance_biz 带出业务定位信息（model/record），
     * 前端「已办列表」需要它才能跳回对应记录。
     * 排除 action='AUTO'：那是系统挂起告警（operator_id=0），不是人的办理动作。
     */
    @Override
    public List<Map<String, Object>> listTasksByOperator(long tenantId, long operatorId) {
        return jdbc.queryForList("""
                SELECT l.task_id, l.instance_id, l.node_id, l.action, l.comment, l.operated_at,
                       b.model_id, b.record_id, b.flow_def_id, b.started_by, b.status
                FROM flow_task_log l
                LEFT JOIN flow_instance_biz b
                       ON b.instance_id = l.instance_id AND b.tenant_id = l.tenant_id
                WHERE l.tenant_id = ? AND l.operator_id = ? AND l.action <> 'AUTO'
                ORDER BY l.operated_at DESC
                """, tenantId, operatorId);
    }
}