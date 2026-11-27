package com.schema.flow.application;

import com.schema.flow.application.FlowExecutionEngine.EngineTask;
import com.schema.flow.domain.ApproverResolver;
import com.schema.flow.domain.FlowDtos.FlowEdge;
import com.schema.flow.domain.FlowDtos.FlowNode;
import com.schema.flow.domain.FlowDtos.FlowSchema;
import com.schema.flow.domain.FlowDtos.UserApprover;
import com.schema.flow.domain.FlowErrors;
import com.schema.flow.domain.FlowSchemaMapper;
import com.schema.flow.domain.repository.FlowDefinitionRepository;
import com.schema.flow.domain.repository.FlowInstanceRepository;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DuplicateKeyException;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 实例与任务服务单测（spec 021 T5）。
 *
 * ⚠️ 测试写法要点：{@code TenantContext.with()} 是**作用域**语义（finally 还原），
 * 在 {@code @BeforeEach} 里传 {@code () -> null} 会立即失效，
 * service 读到的 operatorId 会回落到 DEFAULT=1——所有「按当前用户」的断言都会假失败。
 * 因此每个用例都用 {@link #asOperator} 把业务调用包在作用域内。
 *
 * 覆盖验收项语义（真实 IT 由 T8 承担）：
 *   A3 越权办理 / A4 并发办理 / A5 重复发起
 *   A8 拒绝终止语义 / A9 审批人为空挂起 / A10 事务回滚 / A12 凭证不入变量
 */
class FlowInstanceServiceTest {

    private static final long TENANT = 51L;
    private static final long OPERATOR = 100L;

    private FakeDefRepo defRepo;
    private FakeInstRepo instRepo;
    private FakeEngine engine;
    private FakeOrg org;
    private FlowInstanceService service;

    @BeforeEach
    void setUp() {
        defRepo = new FakeDefRepo();
        instRepo = new FakeInstRepo();
        engine = new FakeEngine();
        org = new FakeOrg();
        // T7 后构造器改为可选注入通知端口，测试用静态工厂（不关心通知 → NOOP）
        service = FlowInstanceService.forTest(defRepo, instRepo, engine, org);
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    /** 在「当前操作人 = OPERATOR」的租户作用域内执行。 */
    private void asOperator(Runnable body) {
        TenantContext.with(new TenantInfo(TENANT, 1L, OPERATOR), () -> {
            body.run();
            return null;
        });
    }

    // ---------- 发起 ----------

    @Test
    void startsInstanceForPublishedFlow() {
        long defId = defRepo.addPublished(1L, linear());
        engine.onStart = vars -> "inst-1";

        asOperator(() -> {
            Map<String, Object> out = service.start(1L, 500L, defId);
            assertEquals("inst-1", out.get("instanceId"));
        });

        assertNotNull(instRepo.byInstance.get("inst-1"), "必须落库业务绑定");
        assertEquals("RUNNING", instRepo.byInstance.get("inst-1").get("status"));
    }

    @Test
    void rejectsUnpublishedFlow() {
        long defId = defRepo.addDraft(1L, linear());

        asOperator(() -> {
            BizException e = assertThrows(BizException.class,
                    () -> service.start(1L, 500L, defId));
            assertEquals(FlowErrors.FLOW_DEF_NOT_PUBLISHED, e.code());
        });
    }

    @Test
    void recordsFlowDefinitionVersionOnStart() {
        // 2026-11-27 评审修复：flow_schema 是可覆盖草稿，必须记住发起时是哪一版，
        // 否则审批中心渲染旧实例会配上新图（轨迹与图形对不上）。
        long defId = defRepo.addPublished(1L, linear());
        engine.onStart = vars -> "inst-ver";

        asOperator(() -> assertEquals("inst-ver", service.start(1L, 501L, defId).get("instanceId")));

        Object ver = instRepo.byInstance.get("inst-ver").get("flow_def_version");
        assertNotNull(ver, "发起时必须记录流程定义版本");
        assertTrue(((Number) ver).intValue() >= 1, "版本号应为正整数");
    }

    @Test
    void rejectsMissingDefinition() {
        asOperator(() -> {
            BizException e = assertThrows(BizException.class, () -> service.start(1L, 500L, 9999));
            assertEquals(FlowErrors.FLOW_DEF_NOT_FOUND, e.code());
        });
    }

    /** A5：同记录同流程第二实例被唯一索引拒绝。 */
    @Test
    void duplicateStartIsRejected() {
        long defId = defRepo.addPublished(1L, linear());
        engine.onStart = vars -> "inst-" + engine.startCount;
        asOperator(() -> service.start(1L, 500L, defId));

        asOperator(() -> {
            instRepo.failNextInsertWithDuplicate = true;
            BizException e = assertThrows(BizException.class,
                    () -> service.start(1L, 500L, defId));
            assertEquals(FlowErrors.INSTANCE_ALREADY_RUNNING, e.code());
        });
        assertTrue(engine.startCount >= 2, "应先尝试引擎发起，再由 DB 约束兜底");
    }

    /** A12：流程变量只含业务标识，不含 token/会话凭证。 */
    @Test
    void variablesContainNoCredentials() {
        long defId = defRepo.addPublished(1L, linear());
        engine.onStart = vars -> "inst-1";

        asOperator(() -> service.start(1L, 500L, defId));

        Map<String, Object> captured = engine.lastVariables;
        assertNotNull(captured);
        for (String k : captured.keySet()) {
            String lower = k.toLowerCase();
            assertFalse(lower.contains("token") || lower.contains("session")
                    || lower.contains("cookie") || lower.contains("csrf")
                    || lower.contains("password"),
                    "流程变量不得含凭证类字段: " + k);
        }
        // T7 后新增 tenantId（供通知适配器取租户）——仍是业务标识，不是凭证。
        assertEquals(List.of("flowDefId", "initiator", "modelId", "recordId", "tenantId"),
                captured.keySet().stream().sorted().toList());
    }

    /** A9：审批人解析为空 → 实例挂起 + 记录 BLOCK。 */
    @Test
    void suspendsWhenApproverResolvesEmpty() {
        long defId = defRepo.addPublished(1L, linear());
        engine.onStart = vars -> "inst-1";
        defRepo.overrideSchema(defId, linearWithEmptyApprover());

        asOperator(() -> service.start(1L, 500L, defId));

        assertEquals("SUSPENDED", instRepo.byInstance.get("inst-1").get("status"));
        assertTrue(engine.suspended.contains("inst-1"), "必须调用引擎挂起");
        assertTrue(instRepo.logs.stream()
                        .anyMatch(x -> String.valueOf(x.get("comment")).contains("BLOCK")),
                "必须留审计记录（本期唯一告警通道）");
    }

    @Test
    void doesNotSuspendWhenApproverResolved() {
        long defId = defRepo.addPublished(1L, linear());
        engine.onStart = vars -> "inst-1";

        asOperator(() -> service.start(1L, 500L, defId));

        assertEquals("RUNNING", instRepo.byInstance.get("inst-1").get("status"));
        assertTrue(engine.suspended.isEmpty());
    }

    // ---------- 办理 ----------

    /** A3：非候选人办理 → TASK_NOT_ASSIGNED。 */
    @Test
    void rejectsCompletionByNonCandidate() {
        engine.tasks.put("t1", task("t1", "inst-1", List.of(777L), null));

        asOperator(() -> {
            BizException e = assertThrows(BizException.class,
                    () -> service.complete("t1", true, "ok"));
            assertEquals(FlowErrors.TASK_NOT_ASSIGNED, e.code());
        });
    }

    /** A4：任务已结束 → TASK_ALREADY_COMPLETED。 */
    @Test
    void rejectsCompletionOfFinishedInstance() {
        engine.tasks.put("t1", task("t1", "inst-1", List.of(OPERATOR), null));
        engine.finished.add("inst-1");

        asOperator(() -> {
            BizException e = assertThrows(BizException.class,
                    () -> service.complete("t1", true, "ok"));
            assertEquals(FlowErrors.TASK_ALREADY_COMPLETED, e.code());
        });
    }

    @Test
    void rejectsMissingTask() {
        asOperator(() -> {
            BizException e = assertThrows(BizException.class,
                    () -> service.complete("nope", true, "ok"));
            assertEquals(FlowErrors.TASK_NOT_FOUND, e.code());
        });
    }

    @Test
    void allowsCompletionByAssignee() {
        engine.tasks.put("t1", task("t1", "inst-1", List.of(), OPERATOR));
        instRepo.byInstance.put("inst-1", bindRow("inst-1", "RUNNING"));

        asOperator(() -> {
            Map<String, Object> out = service.complete("t1", true, "同意");
            assertEquals(Boolean.TRUE, out.get("approved"));
        });
        assertEquals(1, engine.completed.size());
    }

    @Test
    void allowsCompletionByCandidate() {
        engine.tasks.put("t1", task("t1", "inst-1", List.of(OPERATOR), null));
        instRepo.byInstance.put("inst-1", bindRow("inst-1", "RUNNING"));

        asOperator(() -> service.complete("t1", true, "同意"));

        assertEquals(1, engine.completed.size());
    }

    @Test
    void rejectsWithoutCommentAndDoesNothing() {
        engine.tasks.put("t1", task("t1", "inst-1", List.of(OPERATOR), null));

        asOperator(() -> {
            BizException e = assertThrows(BizException.class,
                    () -> service.complete("t1", false, "  "));
            assertEquals(FlowErrors.COMMENT_REQUIRED, e.code());
        });
        assertTrue(engine.completed.isEmpty(), "校验失败不得真正办理");
    }

    /** A8：拒绝 = 终止语义，实例 FINISHED。 */
    @Test
    void rejectTerminatesInstance() {
        engine.tasks.put("t1", task("t1", "inst-1", List.of(OPERATOR), null));
        instRepo.byInstance.put("inst-1", bindRow("inst-1", "RUNNING"));
        engine.stateAfterComplete = "FINISHED";

        asOperator(() -> service.complete("t1", false, "材料不全"));

        assertEquals("FINISHED", instRepo.byInstance.get("inst-1").get("status"));
        assertTrue(instRepo.logs.stream().anyMatch(x -> "REJECT".equals(x.get("action"))),
                "拒绝必须留审计");
    }

    /** 办理成功必须留全量审计（T7 flow_task_log）。 */
    @Test
    void recordsAuditLogOnCompletion() {
        engine.tasks.put("t1", task("t1", "inst-1", List.of(OPERATOR), null));
        instRepo.byInstance.put("inst-1", bindRow("inst-1", "RUNNING"));

        asOperator(() -> service.complete("t1", true, "同意"));

        assertEquals(1, instRepo.logs.size());
        Map<String, Object> logRow = instRepo.logs.get(0);
        assertEquals("COMPLETE", logRow.get("action"));
        assertEquals(OPERATOR, logRow.get("operator_id"));
        assertEquals("同意", logRow.get("comment"));
    }

    /** A10：业务写入失败 → 异常必须向上抛出（由 @Transactional 回滚），不被吞掉。 */
    @Test
    void propagatesFailureSoTransactionCanRollBack() {
        engine.tasks.put("t1", task("t1", "inst-1", List.of(OPERATOR), null));
        instRepo.byInstance.put("inst-1", bindRow("inst-1", "RUNNING"));
        // 走「同意且流程结束」分支——该分支才会写实例状态，注入点才生效
        engine.stateAfterComplete = "FINISHED";
        instRepo.failNextUpdateStatus = true;

        asOperator(() -> assertThrows(IllegalStateException.class,
                () -> service.complete("t1", true, "同意")));

        assertEquals("RUNNING", instRepo.byInstance.get("inst-1").get("status"));
    }

    // ---------- 待办 ----------

    @Test
    void listsMyTasks() {
        engine.tasks.put("t1", task("t1", "inst-1", List.of(OPERATOR), null));

        asOperator(() -> {
            Map<String, Object> out = service.myTasks();
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> list = (List<Map<String, Object>>) out.get("list");
            assertEquals(1, list.size());
            assertEquals("t1", list.get(0).get("taskId"));
        });
    }

    @Test
    void emptyTasksWhenEngineUnavailable() {
        engine.available = false;

        asOperator(() -> {
            Map<String, Object> out = service.myTasks();
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> list = (List<Map<String, Object>>) out.get("list");
            assertTrue(list.isEmpty(), "引擎关闭时「没有待办」是正确语义，不报错");
        });
    }

    // ---------- 详情 ----------

    @Test
    void detailMergesBusinessAndHistory() {
        instRepo.byInstance.put("inst-1", bindRow("inst-1", "RUNNING"));
        engine.history.add(Map.of("activityId", "a1", "activityName", "主管审批"));

        asOperator(() -> {
            Map<String, Object> out = service.detail("inst-1");
            assertEquals("inst-1", out.get("instanceId"));
            assertEquals(500L, out.get("recordId"));
            assertNotNull(out.get("history"));
        });
    }

    @Test
    void detailOfMissingInstanceIsNotFound() {
        asOperator(() -> {
            BizException e = assertThrows(BizException.class, () -> service.detail("ghost"));
            assertEquals(FlowErrors.INSTANCE_NOT_FOUND, e.code());
        });
    }

    // ---------- fixtures ----------

    private static FlowSchema linear() {
        return new FlowSchema("leave", "请假流程", 1, 1,
                List.of(new FlowNode("s1", "START", "开始", null, null),
                        new FlowNode("a1", "APPROVAL", "主管审批",
                                new UserApprover(List.of(String.valueOf(OPERATOR))), null),
                        new FlowNode("e1", "END", "结束", null, null)),
                List.of(new FlowEdge("f1", "s1", "a1", null),
                        new FlowEdge("f2", "a1", "e1", null)));
    }

    private static FlowSchema linearWithEmptyApprover() {
        return new FlowSchema("leave", "请假流程", 1, 1,
                List.of(new FlowNode("s1", "START", "开始", null, null),
                        new FlowNode("a1", "APPROVAL", "主管审批",
                                new UserApprover(List.of()), null),
                        new FlowNode("e1", "END", "结束", null, null)),
                List.of(new FlowEdge("f1", "s1", "a1", null),
                        new FlowEdge("f2", "a1", "e1", null)));
    }

    private static EngineTask task(String id, String instId, List<Long> candidates, Long assignee) {
        return new EngineTask(id, instId, "a1", "主管审批", candidates, assignee,
                OffsetDateTime.now());
    }

    private static Map<String, Object> bindRow(String instanceId, String status) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("instance_id", instanceId);
        row.put("tenant_id", TENANT);
        row.put("model_id", 1L);
        row.put("record_id", 500L);
        row.put("status", status);
        return row;
    }

    // ---------- 测试替身 ----------

    private static class FakeDefRepo implements FlowDefinitionRepository {
        final Map<Long, Map<String, Object>> store = new LinkedHashMap<>();
        private final AtomicLong seq = new AtomicLong(0);

        long addPublished(long appId, FlowSchema schema) {
            return add(appId, schema, "PUBLISHED");
        }

        long addDraft(long appId, FlowSchema schema) {
            return add(appId, schema, "DRAFT");
        }

        private long add(long appId, FlowSchema schema, String status) {
            long id = seq.incrementAndGet();
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", id);
            row.put("tenant_id", TENANT);
            row.put("app_id", appId);
            row.put("flow_key", schema.flowKey());
            row.put("name", schema.name());
            row.put("status", status);
            row.put("version", 1);
            row.put("flow_schema", FlowSchemaMapper.toJson(schema));
            store.put(id, row);
            return id;
        }

        void overrideSchema(long id, FlowSchema schema) {
            store.get(id).put("flow_schema", FlowSchemaMapper.toJson(schema));
        }

        @Override
        public long insert(long tenantId, long appId, String flowKey, String name, String status,
                String flowSchemaJson, long createdBy) {
            return add(appId, FlowSchemaMapper.fromJson(flowSchemaJson), status);
        }

        @Override
        public Optional<Map<String, Object>> findById(long tenantId, long id) {
            return Optional.ofNullable(store.get(id));
        }

        @Override
        public Optional<Map<String, Object>> findByKey(long tenantId, long appId, String flowKey) {
            return store.values().stream()
                    .filter(r -> flowKey.equals(r.get("flow_key"))).findFirst();
        }

        @Override
        public List<Map<String, Object>> listByApp(long tenantId, long appId) {
            return new ArrayList<>(store.values());
        }

        @Override
        public int updateDraft(long tenantId, long id, int baseVersion, String flowSchemaJson) {
            return 1;
        }

        @Override
        public int markPublished(long tenantId, long id, int expectedVersion, int nextVersion,
                String flowSchemaJson, String deploymentId) {
            return 1;
        }
    }

    private static class FakeInstRepo implements FlowInstanceRepository {
        final Map<String, Map<String, Object>> byInstance = new LinkedHashMap<>();
        final List<Map<String, Object>> logs = new ArrayList<>();
        boolean failNextInsertWithDuplicate = false;
        boolean failNextUpdateStatus = false;

        @Override
        public long insert(String instanceId, long tenantId, long modelId, long recordId,
                long flowDefId, long startedBy, String status) {
            if (failNextInsertWithDuplicate) {
                failNextInsertWithDuplicate = false;
                throw new DuplicateKeyException("uq_flow_active");
            }
            Map<String, Object> row = bindRow(instanceId, status);
            row.put("flow_def_id", flowDefId);
            row.put("started_by", startedBy);
            byInstance.put(instanceId, row);
            return 1L;
        }

        @Override
        public Optional<Map<String, Object>> findByInstanceId(long tenantId, String instanceId) {
            return Optional.ofNullable(byInstance.get(instanceId));
        }

        /** 记录执行版本（2026-11-27）：写进桩行，供断言「发起时记了哪一版」。 */
        @Override
        public void recordDefVersion(long tenantId, String instanceId, Integer defVersion) {
            if (defVersion == null) return;
            Map<String, Object> row = byInstance.get(instanceId);
            if (row != null) row.put("flow_def_version", defVersion);
        }

        @Override
        public List<Map<String, Object>> findByBizRecord(long tenantId, long modelId, long recordId) {
            return new ArrayList<>(byInstance.values());
        }

        @Override
        public int updateStatus(long tenantId, String instanceId, String status) {
            if (failNextUpdateStatus) {
                failNextUpdateStatus = false;
                throw new IllegalStateException("业务状态写入失败（A10 注入）");
            }
            Map<String, Object> row = byInstance.get(instanceId);
            if (row != null) {
                row.put("status", status);
            }
            return 1;
        }

        @Override
        public void insertTaskLog(long tenantId, String taskId, String instanceId, String nodeId,
                String action, long operatorId, String comment, OffsetDateTime operatedAt) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("task_id", taskId);
            row.put("instance_id", instanceId);
            row.put("node_id", nodeId);
            row.put("action", action);
            row.put("operator_id", operatorId);
            row.put("comment", comment);
            logs.add(row);
        }

        @Override
        public List<Map<String, Object>> listTaskLogs(long tenantId, String instanceId) {
            return new ArrayList<>(logs);
        }

        /**
         * 已办（T5）：从记录下来的 taskLog 里按 operatorId 过滤。
         *
         * 与真实实现保持同一语义——排除 action='AUTO'（系统挂起告警）。
         */
        @Override
        public List<Map<String, Object>> listTasksByOperator(long tenantId, long operatorId) {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Map<String, Object> log : logs) {
                Object op = log.get("operator_id");
                Object action = log.get("action");
                if (op instanceof Number n && n.longValue() == operatorId
                        && !"AUTO".equals(String.valueOf(action))) {
                    out.add(log);
                }
            }
            return out;
        }
    }

    private static class FakeEngine implements FlowExecutionEngine {
        final Map<String, EngineTask> tasks = new HashMap<>();
        final List<String> suspended = new ArrayList<>();
        final List<String> completed = new ArrayList<>();
        final List<Map<String, Object>> history = new ArrayList<>();
        final Set<String> finished = new HashSet<>();
        boolean available = true;
        int startCount = 0;
        String stateAfterComplete = "RUNNING";
        Map<String, Object> lastVariables;
        java.util.function.Function<Map<String, Object>, String> onStart = v -> "inst-x";

        @Override
        public boolean isAvailable() {
            return available;
        }

        @Override
        public String start(String processDefinitionKey, String businessKey,
                Map<String, Object> variables) {
            startCount++;
            lastVariables = new LinkedHashMap<>(variables);
            return onStart.apply(variables);
        }

        @Override
        public List<EngineTask> listTasks(long tenantId, long candidateUserId) {
            return tasks.values().stream()
                    .filter(t -> t.isActionableBy(candidateUserId)).toList();
        }

        @Override
        public EngineTask findTask(String taskId) {
            return tasks.get(taskId);
        }

        @Override
        public void complete(String taskId, boolean approved, String comment, long operatorId) {
            completed.add(taskId);
            tasks.remove(taskId);
        }

        @Override
        public boolean isFinished(String instanceId) {
            return finished.contains(instanceId);
        }

        @Override
        public String instanceState(String instanceId) {
            return stateAfterComplete;
        }

        @Override
        public void suspend(String instanceId, String reason) {
            suspended.add(instanceId);
        }

        @Override
        public List<Map<String, Object>> historyOf(String instanceId) {
            return new ArrayList<>(history);
        }
    }

    private static class FakeOrg implements ApproverResolver.OrgQueryPort {
        @Override
        public List<Long> findUsersInDeptWithRoles(long tenantId, long deptId, List<String> roleKeys) {
            return List.of();
        }

        @Override
        public Long findPrimaryDeptId(long tenantId, long userId) {
            return null;
        }

        @Override
        public Long findParentDeptId(long tenantId, long deptId) {
            return null;
        }

        @Override
        public List<Long> findUsersInDept(long tenantId, long deptId) {
            return List.of();
        }

        @Override
        public Long findDeptLeaderId(long tenantId, long deptId) {
            return null;
        }
    }
}