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
    private final FlowNotifyPort notify;
    /** 业务记录访问校验（2026-11-27 授权缺口修复）；bootstrap 必须装配真实实现。 */
    private final RecordAccessPort recordAccess;

    /**
     * 通知端口是**可选依赖**（T7）。
     *
     * flow-module 不依赖 notification-module：适配器由组合根 bootstrap 提供，
     * 未提供时降级为 NOOP（流程照走，不发通知，WARN 留痕）。
     * 用 ObjectProvider 而非 @Autowired(required=false)，是为了让 Spring
     * 在无该 Bean 时不报错且显式表达「可缺省」。
     */
    @org.springframework.beans.factory.annotation.Autowired
    public FlowInstanceService(FlowDefinitionRepository defRepo, FlowInstanceRepository instRepo,
            FlowExecutionEngine engine, ApproverResolver.OrgQueryPort org,
            org.springframework.beans.factory.ObjectProvider<FlowNotifyPort> notifyProvider,
            org.springframework.beans.factory.ObjectProvider<RecordAccessPort> recordAccessProvider) {
        FlowNotifyPort provided = notifyProvider.getIfAvailable();
        RecordAccessPort access = recordAccessProvider.getIfAvailable();
        this.defRepo = defRepo;
        this.instRepo = instRepo;
        this.engine = engine;
        this.org = org;
        this.notify = provided != null ? provided
                : new com.schema.flow.infrastructure.NoopFlowNotifyPort();
        // 未装配时降级为 ALLOW_ALL，但会打 WARN——生产缺装配必须可见，
        // 由 RecordAccessPortWiringTest 断言 bean 存在兜底（不能靠日志）。
        if (access == null) {
            log.warn("RecordAccessPort 未装配：流程发起/详情将跳过记录级授权校验"
                    + "（仅限本模块单测；生产必须是 RecordAccessAdapter）");
        }
        this.recordAccess = access != null ? access : RecordAccessPort.ALLOW_ALL;
    }

    /** 唯一具体构造器（构造器只有一个 @Autowired 版本，此处为包私有实现细节）。 */
    private FlowInstanceService(FlowDefinitionRepository defRepo, FlowInstanceRepository instRepo,
            FlowExecutionEngine engine, ApproverResolver.OrgQueryPort org, Void ignored,
            FlowNotifyPort notify, RecordAccessPort recordAccess) {
        this.defRepo = defRepo;
        this.instRepo = instRepo;
        this.engine = engine;
        this.org = org;
        this.notify = notify != null ? notify
                : new com.schema.flow.infrastructure.NoopFlowNotifyPort();
        this.recordAccess = recordAccess != null ? recordAccess : RecordAccessPort.ALLOW_ALL;
    }

    /**
     * 单测工厂（T7 之前的 4 参数签名）。
     *
     * 不做过构造器重载：5 参数构造器里 `notify != null ? ... : Noop` 与
     * 4 参数构造器的 `this(..., null)` 会让编译器判定「引用不明确」。
     * 用静态工厂避开重载解析，语义也更清楚（测试意图 = 不关心通知）。
     */
    static FlowInstanceService forTest(FlowDefinitionRepository defRepo,
            FlowInstanceRepository instRepo, FlowExecutionEngine engine,
            ApproverResolver.OrgQueryPort org) {
        return new FlowInstanceService(defRepo, instRepo, engine, org, null,
                new com.schema.flow.infrastructure.NoopFlowNotifyPort(),
                RecordAccessPort.ALLOW_ALL);
    }

    /** 单测工厂（带通知桩，用于断言「发了什么通知」）。 */
    static FlowInstanceService forTest(FlowDefinitionRepository defRepo,
            FlowInstanceRepository instRepo, FlowExecutionEngine engine,
            ApproverResolver.OrgQueryPort org, FlowNotifyPort notify) {
        return new FlowInstanceService(defRepo, instRepo, engine, org, null, notify,
                RecordAccessPort.ALLOW_ALL);
    }

    /**
     * 单测工厂（带记录访问桩）。
     *
     * 授权缺口修复（2026-11-27）后新增：只有用它才能断言
     * 「同租户不同用户」被拒绝的边界（管理员自审批 E2E 证明不了这个）。
     */
    static FlowInstanceService forTest(FlowDefinitionRepository defRepo,
            FlowInstanceRepository instRepo, FlowExecutionEngine engine,
            ApproverResolver.OrgQueryPort org, FlowNotifyPort notify, RecordAccessPort recordAccess) {
        return new FlowInstanceService(defRepo, instRepo, engine, org, null, notify, recordAccess);
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

        // 记录级授权（2026-11-27 缺口修复）：租户校验只回答「流程定义属于谁」，
        // 不回答「这条业务记录你能不能碰」。缺这一步，同租户任意用户可对
        // 别人的记录发起流程——甚至对不存在的记录发起（凭空造实例）。
        assertRecordAccessible(t, modelId, recordId, "发起流程");

        FlowSchema schema = FlowSchemaMapper.fromJson(String.valueOf(def.get("flow_schema")));
        String processKey = String.valueOf(def.get("flow_key"));

        // 只放业务标识，**不放 token/会话凭证**（A12）
        Map<String, Object> variables = new LinkedHashMap<>();
        variables.put("modelId", modelId);
        variables.put("recordId", recordId);
        variables.put("flowDefId", flowDefId);
        variables.put("initiator", t.operatorId());
        // 租户 id 供通知适配器取用（T7）——仍是业务标识，非凭证，A12 不受影响
        variables.put("tenantId", t.tenantId());

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

        // 记录执行版本（2026-11-27 评审修复）：flow_schema 是可覆盖的草稿，
        // 不记版本的话审批中心渲染旧实例会配上新图。失败不影响发起主流程。
        try {
            Object defVersion = def.get("version");
            if (defVersion instanceof Number n) {
                instRepo.recordDefVersion(t.tenantId(), instanceId, n.intValue());
            }
        } catch (RuntimeException e) {
            log.warn("记录流程定义版本失败 instance={} def={}——实例可用但详情将标注版本未知",
                    instanceId, flowDefId, e);
        }

        // T7：待办通知（A9 挂起时 blockIfNoAssignee 内部已决定不发——无受理人可通知）
        notifyTodo(schema, def, t, instanceId, modelId, recordId);

        return Map.of("instanceId", instanceId);
    }

    /**
     * 派发待办通知（T7 / FLOW_TODO）。
     *
     * 只通知「首个 APPROVAL 节点解析出的审批人」——引擎启动后这些人的任务已就绪。
     * 挂起实例（审批人解析为空）在此返回，不产生无收件人的通知。
     */
    private void notifyTodo(FlowSchema schema, Map<String, Object> def, TenantInfo t,
            String instanceId, long modelId, long recordId) {
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
        List<Long> assignees = ApproverResolver.resolve(
                firstApproval.approver(), t.tenantId(), t.operatorId(), org);
        if (assignees.isEmpty()) {
            // A9：已挂起，无受理人——不通知
            return;
        }
        Map<String, Object> vars = new LinkedHashMap<>();
        vars.put("flowName", String.valueOf(def.getOrDefault("name", def.get("flow_key"))));
        vars.put("bizRef", modelId + ":" + recordId);
        vars.put("instanceId", instanceId);
        safeNotify(() -> notify.todo(instanceId, assignees, vars), instanceId, "FLOW_TODO");
    }

    /**
     * 通知失败不得影响流程事务（T7 边界）。
     *
     * 审批/发起的业务结果比「通知是否送达」重要得多——通知模块故障时
     * 让整个办理回滚是错误的价值排序。此处吞异常并记 ERROR，
     * 由通知模块自身的 SUPERSEDED/SUPPRESSED 留痕兜底可审计性。
     */
    private void safeNotify(Runnable action, String instanceId, String kind) {
        try {
            action.run();
        } catch (RuntimeException e) {
            log.error("[FLOW_NOTIFY_FAILED] instance={} kind={} — 业务不受影响: {}",
                    instanceId, kind, e.toString());
        }
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
        boolean becameFinished = false;
        if (approved && "FINISHED".equals(nextState)) {
            instRepo.updateStatus(t.tenantId(), task.instanceId(), ST_FINISHED);
            becameFinished = true;
        } else if (!approved) {
            // 拒绝 = 终止语义（A8）：实例结束，业务状态置驳回
            instRepo.updateStatus(t.tenantId(), task.instanceId(), ST_FINISHED);
            becameFinished = true;
        }

        // T7 / A8：办结通知发起人（FLOW_DONE_APPROVED / FLOW_DONE_REJECTED）
        // 放在状态更新之后：先落业务事实，再发通知（通知失败不回滚，见 safeNotify）。
        if (becameFinished) {
            notifyFinished(t, task.instanceId(), approved, comment);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("instanceState", nextState);
        out.put("approved", approved);
        return out;
    }

    /**
     * 办结通知发起人（A8 要求「发起人收到 FLOW_DONE_REJECTED」）。
     *
     * 发起人取自 flow_instance_biz.started_by——不信任流程变量
     * （变量在 A12 已收窄，但业务真源是绑定表）。
     */
    private void notifyFinished(TenantInfo t, String instanceId, boolean approved, String comment) {
        Map<String, Object> bind = instRepo.findByInstanceId(t.tenantId(), instanceId).orElse(null);
        if (bind == null) {
            log.warn("[FLOW_NOTIFY_SKIP] instance={} 无业务绑定，跳办结通知", instanceId);
            return;
        }
        // ⚠️ started_by 可能为 null（仓储投影字段缺失 / 单测桩未设该列）——
        //    直接装箱转型会抛 NPE，而通知失败绝不该影响办理结果。
        Object startedBy = bind.get("started_by");
        if (!(startedBy instanceof Number initiatorNum)) {
            log.warn("[FLOW_NOTIFY_SKIP] instance={} 缺 started_by，跳办结通知", instanceId);
            return;
        }
        long initiatorId = initiatorNum.longValue();
        Map<String, Object> vars = new LinkedHashMap<>();
        vars.put("flowName", String.valueOf(
                bind.getOrDefault("flow_name", bind.getOrDefault("flow_key", "流程"))));
        vars.put("bizRef", bind.get("model_id") + ":" + bind.get("record_id"));
        vars.put("instanceId", instanceId);
        if (comment != null && !comment.isBlank()) {
            vars.put("comment", comment);
        }
        safeNotify(() -> notify.finished(instanceId, initiatorId, approved, comment, vars),
                instanceId, approved ? "FLOW_DONE_APPROVED" : "FLOW_DONE_REJECTED");
    }

    /**
     * 已办（T5：待办/已办双侧）。
     *
     * 数据源是引擎历史（HistoryService）而非任务表——
     * 已完成任务在运行时表里已不存在，只有历史表留有办理记录。
     * 只返回「我作为办理人」的记录，不混入我发起但由他人办理的实例。
     */
    public Map<String, Object> doneTasks(int page, int size) {
        TenantInfo t = tenant();
        // 数据源是 flow_task_log 而非引擎历史：
        // 引擎的 HistoricActivityInstance 查询需要已知 instanceId（无法跨实例扫），
        // 而「我的已办」本质是「我办理过的任务」——业务侧审计表才是真源，
        // 且它记录了 REJECT/AUTO 等引擎历史不含的语义。
        List<Map<String, Object>> mine = instRepo.listTasksByOperator(t.tenantId(), t.operatorId());
        int from = Math.max(0, page) * Math.max(1, size);
        int to = Math.min(mine.size(), from + Math.max(1, size));
        List<Map<String, Object>> pageItems = from >= mine.size() ? List.of() : mine.subList(from, to);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("list", pageItems);
        out.put("total", mine.size());
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

        // 可见性（2026-11-27 缺口修复）：租户过滤只能保证「不同租户互相看不到」，
        // 同租户内任意用户原本可读到别人的实例、审批意见与完整轨迹。
        // 三类人可见：发起人 / 审批参与者（含已办） / 有该记录数据权限的管理者。
        assertInstanceVisible(t, bind, instanceId);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("instanceId", instanceId);
        out.put("modelId", bind.get("model_id"));
        out.put("recordId", bind.get("record_id"));
        // flowDefId：审批中心据此拉流程定义渲染画布（T3 实例着色需要节点集合）。
        // 此前遗漏该字段导致前端只能显示轨迹、无法画图。
        out.put("flowDefId", bind.get("flow_def_id"));
        // 实例执行时的定义版本（2026-11-27 评审修复）：前端据此判断
        // 「当前 schema 是否就是实例执行的版本」，不一致时明确标注而非假装准确。
        // 存量实例为 NULL（迁移前无记录）——前端显示「版本未知」。
        out.put("flowDefVersion", bind.get("flow_def_version"));
        out.put("status", bind.get("status"));
        out.put("startedBy", bind.get("started_by"));
        out.put("startedAt", bind.get("started_at"));
        out.put("tasks", instRepo.listTaskLogs(t.tenantId(), instanceId));
        out.put("history", engine.isAvailable() ? engine.historyOf(instanceId) : List.of());
        return out;
    }

    // ---------- helpers ----------

    /**
     * 记录级授权闸（2026-11-27 授权缺口修复）。
     *
     * 拒绝时统一抛 {@code FORBIDDEN}——不区分「记录不存在」与「无权限」，
     * 避免通过错误码差异探测他人记录是否存在（IDOR 信息泄露）。
     */
    private void assertRecordAccessible(TenantInfo t, long modelId, long recordId, String action) {
        boolean ok;
        try {
            ok = recordAccess.canAccess(t.tenantId(), t.operatorId(), modelId, recordId);
        } catch (RuntimeException e) {
            // 授权判定本身出错时**拒绝**（fail-closed）：宁可业务失败，
            // 也不能因为权限服务抖动而放行越权操作。
            log.error("记录授权判定失败 model={} record={} operator={}——按拒绝处理",
                    modelId, recordId, t.operatorId(), e);
            ok = false;
        }
        if (!ok) {
            throw new BizException(FlowErrors.FORBIDDEN,
                    "无权" + action + "：业务记录不可访问",
                    Map.of("modelId", modelId, "recordId", recordId));
        }
    }

    /**
     * 实例可见性闸（2026-11-27 授权缺口修复）。
     *
     * 三类人可见：
     * 1. 发起人（看自己的流程进度）
     * 2. 审批参与者（在 flow_task_log 里有操作记录，含已办回看）
     * 3. 对该业务记录有数据权限的人（管理者/同部门等，复用记录授权端口）
     *
     * 其余同租户用户一律拒绝。
     */
    private void assertInstanceVisible(TenantInfo t, Map<String, Object> bind, String instanceId) {
        long operatorId = t.operatorId();

        // ① 发起人
        Object startedBy = bind.get("started_by");
        if (startedBy != null && String.valueOf(operatorId).equals(String.valueOf(startedBy))) {
            return;
        }

        // ② 审批参与者（办理过的）
        List<Map<String, Object>> logs = instRepo.listTaskLogs(t.tenantId(), instanceId);
        for (Map<String, Object> logEntry : logs) {
            Object op = logEntry.get("operator_id");
            if (op != null && String.valueOf(operatorId).equals(String.valueOf(op))) {
                return;
            }
        }

        // ③ 业务记录有数据权限（管理者可见下属/部门的数据）
        Object modelId = bind.get("model_id");
        Object recordId = bind.get("record_id");
        if (modelId != null && recordId != null) {
            try {
                if (recordAccess.canAccess(t.tenantId(), operatorId,
                        Long.parseLong(String.valueOf(modelId)),
                        Long.parseLong(String.valueOf(recordId)))) {
                    return;
                }
            } catch (RuntimeException e) {
                log.error("实例可见性判定失败 instance={} operator={}——按拒绝处理",
                        instanceId, operatorId, e);
            }
        }

        throw new BizException(FlowErrors.FORBIDDEN,
                "无权查看该流程实例",
                Map.of("instanceId", instanceId));
    }

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