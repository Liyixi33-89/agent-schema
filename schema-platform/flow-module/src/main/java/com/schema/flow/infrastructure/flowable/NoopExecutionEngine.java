package com.schema.flow.infrastructure.flowable;

import com.schema.flow.application.FlowExecutionEngine;
import com.schema.flow.domain.FlowErrors;
import com.schema.platform.common.web.BizException;

import java.util.List;
import java.util.Map;

/**
 * 无引擎实现（生产/验收库默认态）。
 *
 * isAvailable()=false，所有执行类操作明确失败——
 * 但 listTasks 返回空列表（「引擎关闭时没有待办」是正确语义，不是错误）。
 * 二者区别很重要：查待办页不该因为环境没开引擎就报错，
 * 但发起/办理必须报错，否则会产生「点了一次没反应」的静默失败。
 */
public class NoopExecutionEngine implements FlowExecutionEngine {

    @Override
    public boolean isAvailable() {
        return false;
    }

    @Override
    public String start(String processDefinitionKey, String businessKey, Map<String, Object> variables) {
        throw unavailable("发起实例");
    }

    @Override
    public List<EngineTask> listTasks(long tenantId, long candidateUserId) {
        return List.of();
    }

    @Override
    public EngineTask findTask(String taskId) {
        return null;
    }

    @Override
    public void complete(String taskId, boolean approved, String comment, long operatorId) {
        throw unavailable("办理任务");
    }

    @Override
    public boolean isFinished(String instanceId) {
        return false;
    }

    @Override
    public String instanceState(String instanceId) {
        return "UNKNOWN";
    }

    @Override
    public void suspend(String instanceId, String reason) {
        // 无引擎时无可挂起对象——静默返回，由调用方的状态记录承担语义
    }

    @Override
    public List<Map<String, Object>> historyOf(String instanceId) {
        return List.of();
    }

    private static BizException unavailable(String action) {
        return new BizException(FlowErrors.FLOW_DEF_NOT_PUBLISHED,
                "流程引擎未启用（FLOWABLE_ENABLED=false），无法" + action,
                Map.of("hint", "需在具备 ACT_* 表的环境显式启用"));
    }
}