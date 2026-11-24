package com.schema.flow.application;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

/**
 * 流程运行时引擎端口（DIP：应用层只依赖此接口，Flowable 只在实现层出现）。
 *
 * 为什么需要这层：T5 的核心价值是「业务语义 + 事务边界」——
 * 发起幂等、任务归属校验、complete 与业务状态同事务、拒绝终止语义。
 * 这些**必须能脱离 Flowable 单独验证**；若直接调 RuntimeService/TaskService，
 * 每个用例都要真实引擎，测试既慢又难覆盖边界（并发、回滚、无候选人）。
 *
 * 实现：
 * - {@link com.schema.flow.infrastructure.flowable.FlowableExecutionEngine}（引擎开启）
 * - {@link com.schema.flow.infrastructure.flowable.NoopExecutionEngine}（引擎关闭：明确失败）
 */
public interface FlowExecutionEngine {

    /** 引擎是否可用（决定发起/办理能否进行）。 */
    boolean isAvailable();

    /**
     * 发起实例。
     *
     * @param processDefinitionKey 流程 key（发布时用作 deployment/process 的 id）
     * @param businessKey 业务键（model:record，便于引擎侧反查）
     * @param variables 流程变量——**禁止放入 token/会话凭证**（A12）
     * @return 引擎实例 id
     */
    String start(String processDefinitionKey, String businessKey, Map<String, Object> variables);

    /**
     * 查询某用户的待办任务。
     *
     * @param candidateUserId 候选人/受理人 id
     */
    List<EngineTask> listTasks(long tenantId, long candidateUserId);

    /** 按任务 id 取任务（含归属信息，供权限校验）。 */
    EngineTask findTask(String taskId);

    /**
     * 完成任务。
     *
     * @param approved true=同意，false=拒绝（拒绝由调用方决定终止语义，见服务层）
     * @param comment 审批意见（拒绝时必填——服务层校验）
     */
    void complete(String taskId, boolean approved, String comment, long operatorId);

    /** 实例是否已结束。 */
    boolean isFinished(String instanceId);

    /** 实例状态（RUNNING/FINISHED/SUSPENDED/TERMINATED）。 */
    String instanceState(String instanceId);

    /** 挂起实例（审批人解析为空时 BLOCK 策略使用）。 */
    void suspend(String instanceId, String reason);

    /** 实例轨迹（节点/任务时间线；详情聚合用）。 */
    List<Map<String, Object>> historyOf(String instanceId);

    /** 引擎侧任务视图。 */
    record EngineTask(
            String taskId,
            String instanceId,
            String nodeId,
            String nodeName,
            List<Long> candidateUserIds,
            Long assigneeId,
            OffsetDateTime createdAt) {

        /**
         * 该用户是否有权办理此任务（候选人 或 已受理）。
         *
         * ⚠️ 必须用 equals 或先拆箱：assigneeId 是 Long（装箱），
         * 写成 {@code assigneeId == userId} 会变成引用比较——超过 127 的 id
         * 一律不相等，导致「受理人自己反而无权办理」这种极难排查的缺陷。
         */
        public boolean isActionableBy(long userId) {
            if (assigneeId != null) {
                return assigneeId == userId || assigneeId.longValue() == userId;
            }
            return candidateUserIds != null && candidateUserIds.contains(userId);
        }
    }
}