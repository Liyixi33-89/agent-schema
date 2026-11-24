package com.schema.flow.infrastructure.flowable;

import com.schema.flow.application.FlowExecutionEngine;
import com.schema.flow.domain.FlowErrors;
import com.schema.platform.common.web.BizException;
import org.flowable.engine.HistoryService;
import org.flowable.engine.RuntimeService;
import org.flowable.engine.TaskService;
import org.flowable.engine.history.HistoricActivityInstance;
import org.flowable.engine.runtime.Execution;
import org.flowable.engine.runtime.ProcessInstance;
import org.flowable.task.api.Task;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Flowable 引擎实现（引擎启用时装配）。
 *
 * 只做「协议转换」：把 Flowable 的 Task/ProcessInstance 映射成本域
 * {@link EngineTask} / 简单结构，**不向上泄漏 Flowable 类型**。
 */
public class FlowableExecutionEngine implements FlowExecutionEngine {

    private static final Logger log = LoggerFactory.getLogger(FlowableExecutionEngine.class);

    private final RuntimeService runtimeService;
    private final TaskService taskService;
    private final HistoryService historyService;

    public FlowableExecutionEngine(RuntimeService runtimeService, TaskService taskService,
            HistoryService historyService) {
        this.runtimeService = runtimeService;
        this.taskService = taskService;
        this.historyService = historyService;
    }

    @Override
    public boolean isAvailable() {
        return true;
    }

    @Override
    public String start(String processDefinitionKey, String businessKey, Map<String, Object> variables) {
        try {
            ProcessInstance pi = runtimeService.startProcessInstanceByKey(
                    processDefinitionKey, businessKey, variables);
            return pi.getId();
        } catch (RuntimeException e) {
            throw new BizException(FlowErrors.FLOW_DEF_NOT_PUBLISHED,
                    "发起失败（可能是流程未部署或定义已变更）: " + e.getMessage(),
                    Map.of("processKey", processDefinitionKey));
        }
    }

    @Override
    public List<EngineTask> listTasks(long tenantId, long candidateUserId) {
        // 候选组（candidate group）不参与检索——审批人按 userId 直接指派/候选，
        // 组维度是未来 DEPT 整体审批的扩展点
        List<Task> tasks = taskService.createTaskQuery()
                .taskCandidateOrAssigned(String.valueOf(candidateUserId))
                .orderByTaskCreateTime().desc()
                .list();
        List<EngineTask> out = new ArrayList<>(tasks.size());
        for (Task task : tasks) {
            out.add(toEngineTask(task));
        }
        return out;
    }

    @Override
    public EngineTask findTask(String taskId) {
        Task task = taskService.createTaskQuery().taskId(taskId).singleResult();
        return task == null ? null : toEngineTask(task);
    }

    @Override
    public void complete(String taskId, boolean approved, String comment, long operatorId) {
        Task task = taskService.createTaskQuery().taskId(taskId).singleResult();
        if (task == null) {
            // A4：并发办理时后到的一方会看到任务已不存在
            throw new BizException(FlowErrors.TASK_ALREADY_COMPLETED,
                    "任务已被处理", Map.of("taskId", taskId));
        }
        try {
            Map<String, Object> vars = new LinkedHashMap<>();
            vars.put("approved", approved);
            vars.put("comment", comment);
            vars.put("operator", operatorId);
            // 不加签受理人：由候选直接完成，避免「先认领再办理」的两步交互
            taskService.complete(taskId, vars);
        } catch (org.flowable.common.engine.api.FlowableOptimisticLockingException e) {
            throw new BizException(FlowErrors.TASK_ALREADY_COMPLETED,
                    "任务已被他人处理", Map.of("taskId", taskId));
        }
    }

    @Override
    public boolean isFinished(String instanceId) {
        return runtimeService.createProcessInstanceQuery()
                .processInstanceId(instanceId).count() == 0;
    }

    @Override
    public String instanceState(String instanceId) {
        // 运行中查运行时表；已结束查历史（A8 拒绝后需返回终态）
        List<Execution> running = runtimeService.createExecutionQuery()
                .processInstanceId(instanceId).list();
        ProcessInstance pi = runtimeService.createProcessInstanceQuery()
                .processInstanceId(instanceId).singleResult();
        if (pi != null) {
            return pi.isSuspended() ? "SUSPENDED" : "RUNNING";
        }
        var historic = historyService.createHistoricProcessInstanceQuery()
                .processInstanceId(instanceId).singleResult();
        if (historic != null) {
            return historic.getDeleteReason() == null ? "FINISHED" : "TERMINATED";
        }
        return running.isEmpty() ? "UNKNOWN" : "RUNNING";
    }

    @Override
    public void suspend(String instanceId, String reason) {
        try {
            runtimeService.suspendProcessInstanceById(instanceId);
            log.warn("[FLOW_ALERT] 实例 {} 已挂起: {}", instanceId, reason);
        } catch (RuntimeException e) {
            // 挂起失败不应使发起整体失败——业务侧状态与审计已记录，可人工介入
            log.error("挂起实例失败 instance={} reason={}", instanceId, reason, e);
        }
    }

    @Override
    public List<Map<String, Object>> historyOf(String instanceId) {
        List<HistoricActivityInstance> acts = historyService.createHistoricActivityInstanceQuery()
                .processInstanceId(instanceId)
                .orderByHistoricActivityInstanceStartTime().asc()
                .list();
        List<Map<String, Object>> out = new ArrayList<>(acts.size());
        for (HistoricActivityInstance a : acts) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("activityId", a.getActivityId());
            item.put("activityName", a.getActivityName());
            item.put("activityType", a.getActivityType());
            item.put("assignee", a.getAssignee());
            if (a.getStartTime() != null) {
                item.put("startedAt", a.getStartTime().toInstant()
                        .atZone(ZoneId.systemDefault()).toOffsetDateTime());
            }
            if (a.getEndTime() != null) {
                item.put("endedAt", a.getEndTime().toInstant()
                        .atZone(ZoneId.systemDefault()).toOffsetDateTime());
            }
            out.add(item);
        }
        return out;
    }

    private EngineTask toEngineTask(Task task) {
        List<Long> candidates = new ArrayList<>();
        // 候选人是 identity link——按 userId 直接指派时 assignee 非空，候选为空
        taskService.getIdentityLinksForTask(task.getId()).forEach(link -> {
            if ("candidate".equals(link.getType()) && link.getUserId() != null) {
                try {
                    candidates.add(Long.parseLong(link.getUserId()));
                } catch (NumberFormatException ignored) {
                    // 组候选（groupId）不参与 userId 匹配
                }
            }
        });
        Long assignee = null;
        if (task.getAssignee() != null) {
            try {
                assignee = Long.parseLong(task.getAssignee());
            } catch (NumberFormatException ignored) {
                // 非数字 assignee（如 userKey）视为未指派
            }
        }
        return new EngineTask(
                task.getId(),
                task.getProcessInstanceId(),
                task.getTaskDefinitionKey(),
                task.getName(),
                candidates,
                assignee,
                task.getCreateTime() == null ? null
                        : task.getCreateTime().toInstant()
                                .atZone(ZoneId.systemDefault()).toOffsetDateTime());
    }
}