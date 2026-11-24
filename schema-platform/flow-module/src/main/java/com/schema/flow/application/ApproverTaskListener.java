package com.schema.flow.application;

import com.schema.flow.domain.ApproverResolver;
import com.schema.flow.domain.FlowDtos.ApproverRule;
import com.schema.flow.domain.FlowDtos.DeptRoleApprover;
import com.schema.flow.domain.FlowDtos.FlowNode;
import com.schema.flow.domain.FlowDtos.FlowSchema;
import com.schema.flow.domain.FlowDtos.InitiatorSupervisorApprover;
import com.schema.flow.domain.FlowDtos.UserApprover;
import com.schema.flow.domain.FlowErrors;
import com.schema.flow.domain.FlowSchemaMapper;
import com.schema.flow.domain.repository.FlowDefinitionRepository;
import com.schema.flow.domain.repository.FlowInstanceRepository;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.flowable.engine.delegate.TaskListener;
import org.flowable.task.service.delegate.DelegateTask;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 审批人解析 TaskListener（spec 021 T6）。
 *
 * 在 userTask 的 create 事件上运行：按节点的 ApproverRule 三模式解析出候选人，
 * 写入引擎的候选身份链接。解析为空时**不抛异常**（那会让发起失败），
 * 而是把任务留在「无候选人」状态，由服务层按 BLOCK 策略挂起实例并告警（A9）。
 *
 * ⚠️ BPMN 中必须用 {@code flowable:delegateExpression="${approverTaskListener}"}
 * 而不是 {@code class="..."}：后者由引擎反射实例化，拿不到 Spring 依赖
 * （实测会报 couldn't instantiate class → 发起直接失败）。
 *
 * ⚠️ 变量白名单：只从流程变量读业务标识，**绝不解包 token/会话**——
 * 流程变量本来就不该有这些（A12 在服务层把关），此处再不引入第二来源。
 */
@Component("approverTaskListener")
public class ApproverTaskListener implements TaskListener {

    private static final Logger log = LoggerFactory.getLogger(ApproverTaskListener.class);

    private final FlowDefinitionRepository defRepo;
    private final FlowInstanceRepository instRepo;
    private final ApproverResolver.OrgQueryPort org;

    public ApproverTaskListener(FlowDefinitionRepository defRepo, FlowInstanceRepository instRepo,
            ApproverResolver.OrgQueryPort org) {
        this.defRepo = defRepo;
        this.instRepo = instRepo;
        this.org = org;
    }

    @Override
    public void notify(DelegateTask task) {
        String instanceId = task.getProcessInstanceId();
        String nodeId = task.getTaskDefinitionKey();
        try {
            Long flowDefId = asLong(task.getVariable("flowDefId"));
            Long initiator = asLong(task.getVariable("initiator"));
            Long modelId = asLong(task.getVariable("modelId"));
            Long recordId = asLong(task.getVariable("recordId"));

            if (flowDefId == null) {
                log.warn("[FLOW_ALERT] 任务 {} 缺少 flowDefId 变量，无法解析审批人", task.getId());
                return;
            }
            // 引擎回调发生在无 HTTP 请求的线程，TenantContext 可能为空 → 用业务绑定兜底
            long tenantId = resolveTenantId(instanceId);

            ApproverRule rule = findApproverRule(tenantId, flowDefId, nodeId);
            if (rule == null) {
                return;
            }

            List<Long> assignees = ApproverResolver.resolve(rule, tenantId,
                    initiator == null ? 0L : initiator, org);

            if (assignees.isEmpty()) {
                // 不抛异常：交由服务层按 BLOCK 处理（A9），此处只留痕
                log.warn("[FLOW_ALERT] 任务 {}（实例 {} 节点 {}）审批人解析为空——规则 {}",
                        task.getId(), instanceId, nodeId, rule.getClass().getSimpleName());
                instRepo.insertTaskLog(tenantId, task.getId(), instanceId, nodeId, "AUTO", 0L,
                        "BLOCK: 审批人解析为空（node " + nodeId + "）", OffsetDateTime.now());
                return;
            }

            if (assignees.size() == 1) {
                // 单人：直接指派（比「候选 + 认领」少一步交互，也更贴合「直属上级」语义）
                task.setAssignee(String.valueOf(assignees.get(0)));
            } else {
                // 多人：全部作为候选人
                for (Long uid : assignees) {
                    task.addCandidateUser(String.valueOf(uid));
                }
            }
            log.debug("task {} 审批人已解析: {} (count={})", task.getId(), assignees, assignees.size());
        } catch (RuntimeException e) {
            // TaskListener 抛异常会中断流程推进——这里必须吞掉并告警，
            // 否则一次组织数据异常会让整个发起事务失败，用户无法继续
            log.error("[FLOW_ALERT] 解析审批人失败 instance={} node={}", instanceId, nodeId, e);
            instRepo.insertTaskLog(resolveTenantId(instanceId), task.getId(), instanceId, nodeId,
                    "AUTO", 0L, "ERROR: 审批人解析异常 " + e.getMessage(), OffsetDateTime.now());
        }
    }

    /** 从业务绑定表取租户（引擎线程无 TenantContext）。 */
    private long resolveTenantId(String instanceId) {
        TenantInfo ctx = TenantContext.get();
        if (ctx != null && ctx != TenantInfo.DEFAULT) {
            return ctx.tenantId();
        }
        return instRepo.findByInstanceId(0L, instanceId)
                .map(r -> asLong(r.get("tenant_id")))
                .filter(java.util.Objects::nonNull)
                .orElse(1L);
    }

    /** 从定义的 flow_schema 中按 nodeId 找到该审批节点的规则。 */
    private ApproverRule findApproverRule(long tenantId, long flowDefId, String nodeId) {
        return defRepo.findById(tenantId, flowDefId)
                .map(row -> {
                    FlowSchema schema = FlowSchemaMapper.fromJson(
                            String.valueOf(row.get("flow_schema")));
                    for (FlowNode n : schema.nodes()) {
                        if (n != null && nodeId.equals(n.id())) {
                            return n.approver();
                        }
                    }
                    return null;
                })
                .orElse(null);
    }

    private static Long asLong(Object o) {
        if (o == null) {
            return null;
        }
        if (o instanceof Number n) {
            return n.longValue();
        }
        try {
            return Long.parseLong(String.valueOf(o).trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }
}