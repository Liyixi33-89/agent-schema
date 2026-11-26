package com.schema.flow.domain.repository;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 流程实例业务绑定仓储（05BE §5）。
 * 唯一索引 uq_flow_active 是发起幂等的最终防线——并发发起由 DB 保证只有一条活跃实例。
 */
public interface FlowInstanceRepository {

    /** 插入实例绑定；违反 uq_flow_active 时抛 DuplicateKeyException（由服务层转 409）。 */
    long insert(String instanceId, long tenantId, long modelId, long recordId, long flowDefId,
            long startedBy, String status);

    Optional<Map<String, Object>> findByInstanceId(long tenantId, String instanceId);

    List<Map<String, Object>> findByBizRecord(long tenantId, long modelId, long recordId);

    /** 更新实例状态（RUNNING → FINISHED/TERMINATED/SUSPENDED）。 */
    int updateStatus(long tenantId, String instanceId, String status);

    /** 记一笔任务办理日志（flow_task_log）。 */
    void insertTaskLog(long tenantId, String taskId, String instanceId, String nodeId,
            String action, long operatorId, String comment, OffsetDateTime operatedAt);

    /** 实例轨迹聚合（详情页数据源）。 */
    List<Map<String, Object>> listTaskLogs(long tenantId, String instanceId);

    /**
     * 「我办理过的任务」（T5 已办）。
     *
     * 只看真实办理动作（COMPLETE / REJECT），排除 AUTO（系统挂起告警）——
     * 后者 operator_id=0，不属于任何人的已办。
     */
    java.util.List<java.util.Map<String, Object>> listTasksByOperator(long tenantId, long operatorId);
}