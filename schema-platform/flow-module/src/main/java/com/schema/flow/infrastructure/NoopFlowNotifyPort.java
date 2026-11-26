package com.schema.flow.infrastructure;

import com.schema.flow.application.FlowNotifyPort;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.Map;

/**
 * 无通知通道时的降级实现（T7）。
 *
 * 何时使用：组合根未装配 {@code FlowNotifyAdapter}（如纯后端集成测试、
 * 或通知模块未启用的部署形态）。此时流程照常走，只是不发通知。
 *
 * ⚠️ 明确记 WARN 而非静默：通知缺失是**可观测的降级**，不是正常态。
 * 与 {@code NoopExecutionEngine} 同一设计立场——降级必须留痕。
 */
public class NoopFlowNotifyPort implements FlowNotifyPort {

    private static final Logger log = LoggerFactory.getLogger(NoopFlowNotifyPort.class);

    @Override
    public void todo(String instanceId, List<Long> assigneeIds, Map<String, Object> vars) {
        log.warn("[FLOW_NOTIFY_NOOP] todo instance={} assignees={} —— 未装配通知通道",
                instanceId, assigneeIds);
    }

    @Override
    public void finished(String instanceId, long initiatorId, boolean approved,
            String comment, Map<String, Object> vars) {
        log.warn("[FLOW_NOTIFY_NOOP] finished instance={} initiator={} approved={} —— 未装配通知通道",
                instanceId, initiatorId, approved);
    }
}