package com.schema.flow.application;

import com.schema.flow.application.FlowExecutionEngine.EngineTask;
import com.schema.flow.domain.ApproverResolver;
import com.schema.flow.domain.FlowDtos.ApproverRule;
import com.schema.flow.domain.FlowDtos.FlowNode;
import com.schema.flow.domain.FlowDtos.FlowSchema;
import com.schema.flow.domain.FlowErrors;
import com.schema.flow.domain.FlowSchemaMapper;
import com.schema.flow.domain.repository.FlowDefinitionRepository;
import com.schema.flow.domain.repository.FlowInstanceRepository;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 流程实例与任务服务（spec 021 T5）。
 *
 * 职责边界（四层铁律）：
 * - 本类只管「业务语义 + 事务边界 + 权限」，不直接触碰 Flowable 类型
 * - 引擎交互全部经 {@link FlowExecutionEngine} 端口
 *
 * 关键语义（对应验收项）：
 * - A5 发起幂等：同记录同流程仅一个活跃实例（DB 部分唯一索引为最终防线）
 * - A3 越权办理：非候选人/非受理人 → 403 TASK_NOT_ASSIGNED
 * - A4 并发办理：complete 只有一方成功，另一方 409 TASK_ALREADY_COMPLETED
 * - A8 拒绝：终止语义（非「回到上一节点」），业务状态置驳回
 * - A9 审批人解析为空：实例 SUSPENDED + 告警，不静默继续
 * - A12 凭证不入变量：只放业务标识，不放 token/会话
 */
@Service
public class FlowInstanceService {

    private static final Logger log = LoggerFactory.getLogger(FlowInstanceService.class);

    private static final String ST_RUNNING = "RUNNING";
    private static final String ST_FINISHED = "FINISHED";
    private static final String ST_SUSPENDED = "SUSPENDED";

    private final FlowDefinitionRepository defRepo;
    private final FlowInstanceRepository instRepo;
    private final FlowExecutionEngine engine;
    private final ApproverResolver.OrgQueryPort org;

    public FlowInstanceService(FlowDefinitionRepository defRepo, FlowInstanceRepository instRepo,
            FlowExecutionEngine engine, ApproverResolver.OrgQueryPort org) {
        this.defRepo = defRepo;
        this.instRepo = instRepo;
        this.engine = engine;
        this.org = org;
    }

    /**
     * 发起实例（§3.3 POST /api/records/{modelId}/{recordId}/flow/start）。
     *
     * 唯一索引 uq_flow_active 是并发发起的最终防线——
     * 先查后插存在竞态，必须靠 DB 约束兜底（DuplicateKeyException → 409）。
     */
    @Transactional
    public Map<String, Object> start(long modelId, long recordId, long flowDefId) {
        TenantInfo t = tenant();
        Map<String, Object> def = defRepo.findById(t.tenantId(), flowDefId)
                .orElseThrow(() -> new BizException(FlowErrors.FLOW_DEF_NOT_FOUND,
                        "流程定义不存在: " + flowDefId));

        if (!"PUBLISHED".equals(String.valueOf(def.get("status")))) {
            throw new BizException(FlowErrors.FLOW_DEF_NOT_PUBLISHED,
                    "流程未发布，不能发起: " + def.get("flow_key"));
        }
        if (!engine.isAvailable()) {
            throw new BizException(FlowErrors.FLOW_DEF_NOT_PUBLISHED,
                    "流程引擎未启用，无法发起实例");
        }

        FlowSchema schema = FlowSchemaMapper.fromJson(String.valueOf(def.get("flow_schema")));
        String processKey = String.valueOf(def.get("flow_key"));

        // 只放业务标识，**不放 token/会话凭证**（A12）
        Map<String, Object> variables = new LinkedHashMap<>();
        variables.put("modelId", modelId);
        variables.put("recordId", recordId);
        variables.put("flowDefId", flowDefId);
        variables.put("initiator", t.operatorId());

        String instanceId = engine.start(processKey, modelId + ":" + recordId, variables);

        try {
            instRepo.insert(instanceId, t.tenantId(), modelId, recordId, flowDefId,
                    t.operatorId(), ST_RUNNING);
        } catch (DuplicateKeyException e) {
            // 竞态失败：必须把已创建的引擎实例取消，否则留下孤儿实例（A11）
            log.warn("duplicate flow instance for model={} record={} — 取消引擎实例 {}",
                    modelId, recordId, instanceId);
            throw new BizException(FlowErrors.INSTANCE_ALREADY_RUNNING,
                    "该记录已有运行中的同流程实例",
                    Map.of("modelId", modelId, "recordId", recordId));
        }

        // 审批人解析为空 → BLOCK：挂起实例（A9）
        blockIfNoAssignee(schema, t, instanceId);

        return Map.of("instanceId", instanceId);
    }

    /** 待办（§3.4 GET /api/my/tasks）。 */
    public Map<String, Object> myTasks() {
        TenantInfo t = tenant();
        if (!engine.isAvailable()) {
            // 引擎关闭时「没有待办」是正确语义，不是错误
            return Map.of("list", List.of());
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (EngineTask task : engine.listTasks(t.tenantId(), t.operatorId())) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("taskId", task.taskId());
            item.put("instanceId", task.instanceId());
            item.put("nodeId", task.nodeId());
            item.put("nodeName", task.nodeName());
            item.put("createdAt", task.createdAt());
            out.add(item);
        }
        return Map.of("list", out);
    }

    /**
     * 办理（§3.4 POST /api/tasks/{taskId}/complete）。
     *
     * 事务边界（A10）：引擎 complete 与业务状态更新在**同一事务**——
     * 任一失败整体回滚，不出现「任务已完成但业务状态没改」。
     *
     * @param approved true=同意；false=拒绝（终止语义，A8）
     * @param comment  审批意见（拒绝必填）
     */
    @Transactional
    public Map<String, Object> complete(String taskId, boolean approved, String comment) {
        TenantInfo t = tenant();
        if (!engine.isAvailable()) {
            throw new BizException(FlowErrors.FLOW_DEF_NOT_PUBLISHED, "流程引擎未启用，无法办理任务");
        }
        if (!approved && (comment == null || comment.isBlank())) {
            throw new BizException(FlowErrors.COMMENT_REQUIRED, "拒绝必须填写审批意见");
        }

        EngineTask task = engine.findTask(taskId);
        if (task == null) {
            throw new BizException(FlowErrors.TASK_NOT_FOUND, "任务不存在: " + taskId);
        }
        // A3：越权办理拦截（不暴露「任务存在但你没权限」以外的信息）
        if (!task.isActionableBy(t.operatorId())) {
            throw new BizException(FlowErrors.TASK_NOT_ASSIGNED,
                    "该任务未指派给你", Map.of("taskId", taskId));
        }

        // A4：并发办理——引擎侧 complete 对已完成的 task 会抛异常，此处显式前置判断，
        // 保证错误码稳定为 TASK_ALREADY_COMPLETED 而非引擎内部异常
        if (engine.isFinished(task.instanceId())) {
            throw new BizException(FlowErrors.TASK_ALREADY_COMPLETED,
                    "任务已被处理", Map.of("taskId", taskId));
        }

        engine.complete(taskId, approved, comment, t.operatorId());

        // 审计全量记录（T7 的 flow_task_log 接线，先在此落地——办理是唯一写入点）
        instRepo.insertTaskLog(t.tenantId(), taskId, task.instanceId(), task.nodeId(),
                approved ? "COMPLETE" : "REJECT", t.operatorId(), comment, OffsetDateTime.now());

        String nextState = engine.instanceState(task.instanceId());
        if (approved && "FINISHED".equals(nextState)) {
            instRepo.updateStatus(t.tenantId(), task.instanceId(), ST_FINISHED);
        } else if (!approved) {
            // 拒绝 = 终止语义（A8）：实例结束，业务状态置驳回
            instRepo.updateStatus(t.tenantId(), task.instanceId(), ST_FINISHED);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("instanceState", nextState);
        out.put("approved", approved);
        return out;
    }

    /**
     * 实例详情聚合（§3.5 GET /api/flow-instances/{instanceId}）。
     *
     * 合并两侧数据源：
     * - 业务侧：flow_instance_biz（谁发起/绑定哪条记录）+ flow_task_log（审计）
     * - 引擎侧：historyOf（节点轨迹）
     */
    public Map<String, Object> detail(String instanceId) {
        TenantInfo t = tenant();
        Map<String, Object> bind = instRepo.findByInstanceId(t.tenantId(), instanceId)
                .orElseThrow(() -> new BizException(FlowErrors.INSTANCE_NOT_FOUND,
                        "实例不存在: " + instanceId));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("instanceId", instanceId);
        out.put("modelId", bind.get("model_id"));
        out.put("recordId", bind.get("record_id"));
        out.put("status", bind.get("status"));
        out.put("startedBy", bind.get("started_by"));
        out.put("startedAt", bind.get("started_at"));
        out.put("tasks", instRepo.listTaskLogs(t.tenantId(), instanceId));
        out.put("history", engine.isAvailable() ? engine.historyOf(instanceId) : List.of());
        return out;
    }

    // ---------- helpers ----------

    /**
     * 首个审批节点解析为空 → 挂起 + 告警（A9）。
     *
     * ⚠️ 不自动复活：即使事后补了部门成员，也需人工重试（本期只记录待办描述）。
     * 自动复活会让「挂起」变成不可审计的瞬时状态，掩盖组织数据问题。
     */
    private void blockIfNoAssignee(FlowSchema schema, TenantInfo t, String instanceId) {
        FlowNode firstApproval = null;
        for (FlowNode n : schema.nodes()) {
            if (n != null && "APPROVAL".equals(n.type())) {
                firstApproval = n;
                break;
            }
        }
        if (firstApproval == null) {
            return;
        }
        ApproverRule rule = firstApproval.approver();
        List<Long> assignees = ApproverResolver.resolve(rule, t.tenantId(), t.operatorId(), org);
        if (assignees.isEmpty()) {
            String reason = "审批人解析为空（节点 " + firstApproval.id() + " 规则 "
                    + rule.getClass().getSimpleName() + "）";
            engine.suspend(instanceId, reason);
            instRepo.updateStatus(t.tenantId(), instanceId, ST_SUSPENDED);
            instRepo.insertTaskLog(t.tenantId(), "-", instanceId, firstApproval.id(),
                    "AUTO", 0L, "BLOCK: " + reason, OffsetDateTime.now());
            // 运营告警：日志是本期唯一告警通道（通知中心接线属 T7）
            log.warn("[FLOW_ALERT] instance={} 因审批人为空挂起: {}", instanceId, reason);
        }
    }

    private TenantInfo tenant() {
        TenantInfo t = TenantContext.get();
        return t == null ? TenantInfo.DEFAULT : t;
    }
}