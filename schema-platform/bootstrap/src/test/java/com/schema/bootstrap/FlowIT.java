package com.schema.bootstrap;

import com.schema.flow.application.FlowDefinitionService;
import com.schema.flow.application.FlowInstanceService;
import com.schema.flow.domain.FlowDtos.DeptRoleApprover;
import com.schema.flow.domain.FlowDtos.FlowEdge;
import com.schema.flow.domain.FlowDtos.FlowNode;
import com.schema.flow.domain.FlowDtos.FlowSchema;
import com.schema.flow.domain.FlowDtos.UserApprover;
import com.schema.flow.domain.FlowErrors;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;

import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 流程执行最小链 IT（spec 021 §5 Acceptance A2-A12，真实 PG + 真实 Flowable）。
 *
 * ⚠️ 本 IT **自带 Flowable 启用**（`flowable.process.enabled=true`）：
 * 本地/CI 的 schema_dev 默认不建 ACT_* 表（生产约束），
 * 因此本测试是唯一需要引擎的用例。首次运行会在库里自动建 32 张 ACT_* 表——
 * 这正是 spec §8 授权第 3 条「IT 库开启自动建表」的落地形态。
 *
 * 隔离策略：使用独立租户号（{@link #TENANT}），前后清理业务表；
 * ACT_* 表按 deployment/instance 粒度清理（不清库，避免影响同库其它 IT）。
 */
@SpringBootTest(classes = com.schema.bootstrap.SchemaApplication.class)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(properties = {
        "spring.datasource.url=jdbc:postgresql://${IT_DB_HOST:localhost}:${IT_DB_PORT:5432}/${IT_DB_NAME:schema_dev}",
        "spring.datasource.username=${IT_DB_USER:schema_dev}",
        "spring.datasource.password=${IT_DB_PASS:schema_local_only}",
        "spring.flyway.clean-disabled=false",
        // 本 IT 专属：启用 Flowable（首次运行自动建 ACT_* 表）
        "flowable.process.enabled=true"
})
class FlowIT {

    private static final long TENANT = 921;
    private static final long OPERATOR = 9001;

    @Autowired
    private FlowDefinitionService defService;

    @Autowired
    private FlowInstanceService instService;

    @Autowired
    private JdbcTemplate jdbc;

    /**
     * 用 Flowable 官方 API 级联清理部署。
     *
     * ⚠️ 为什么不用手工 DELETE：
     * 手工删要按「子表→父表」覆盖全部 10+ 张表（含 ACT_HI_DETAIL/VARINST/IDENTITYLINK 等），
     * 漏一张就撞外键（实测：删 act_re_procdef 时被 act_fk_exe_procdef 拦住）。
     * deleteDeployment(id, true) 由引擎自己保证级联语义，且顺序正确。
     */
    @Autowired
    private org.springframework.beans.factory.ObjectProvider<org.flowable.engine.RepositoryService> repoProvider;

    private long appId;

    @BeforeAll
    void setUp() {
        purgeFlowData();
        // 造一个应用与两个用户（发起人 / 审批人）
        jdbc.update("INSERT INTO app (tenant_id, name, status) VALUES (?, 'IT_FLOW', 'ACTIVE') "
                + "ON CONFLICT DO NOTHING", TENANT);
        Long id = jdbc.queryForObject(
                "SELECT id FROM app WHERE tenant_id = ? AND name = 'IT_FLOW'", Long.class, TENANT);
        appId = id == null ? 0L : id;

        for (long uid : new long[]{OPERATOR, OPERATOR + 1}) {
            jdbc.update("INSERT INTO sys_user (tenant_id, account, name, status) "
                    + "VALUES (?, ?, ?, 'ACTIVE') ON CONFLICT (tenant_id, account) DO NOTHING",
                    TENANT, "it_flow_u" + uid, "流程用户" + uid);
        }
    }

    @AfterAll
    void tearDown() {
        purgeFlowData();
        // 用户与应用也清（避免下轮 app 表重复行）
        jdbc.update("DELETE FROM sys_user WHERE tenant_id = ? AND account LIKE 'it_flow_%'", TENANT);
        jdbc.update("DELETE FROM app WHERE tenant_id = ? AND name = 'IT_FLOW'", TENANT);
    }

    /**
     * 统一的流程数据清理（BeforeAll 与 AfterAll 共用）。
     *
     * 顺序：引擎部署（级联）→ 业务三表 → 部门（先删后插，因为 sys_dept 无
     * (tenant_id, path) 唯一约束，ON CONFLICT DO NOTHING 无从生效）。
     */
    private void purgeFlowData() {
        // ① 引擎侧：按部署名删除，cascade=true 由引擎级联清实例/任务/历史/变量
        org.flowable.engine.RepositoryService rs = repoProvider.getIfAvailable();
        if (rs != null) {
            try {
                List<org.flowable.engine.repository.Deployment> deployments =
                        rs.createDeploymentQuery().deploymentNameLike("it_flow_%").list();
                for (org.flowable.engine.repository.Deployment d : deployments) {
                    rs.deleteDeployment(d.getId(), true);
                }
            } catch (RuntimeException e) {
                // 引擎表尚未创建（本 IT 首次运行前）→ 无数据可清，忽略
            }
        }

        // ② 业务三表
        jdbc.update("DELETE FROM flow_task_log WHERE tenant_id = ?", TENANT);
        jdbc.update("DELETE FROM flow_instance_biz WHERE tenant_id = ?", TENANT);
        jdbc.update("DELETE FROM flow_definition WHERE tenant_id = ?", TENANT);

        // ③ 部门：sys_dept 无 (tenant_id, path) 唯一约束，必须显式删
        jdbc.update("UPDATE sys_user SET dept_id = NULL WHERE tenant_id = ?", TENANT);
        jdbc.update("DELETE FROM sys_dept WHERE tenant_id = ?", TENANT);
    }

    // ---------- fixtures ----------

    /** 标准三节点流程（USER 模式指派 OPERATOR+1）。 */
    private FlowSchema linearFlow(String key) {
        return new FlowSchema(key, "IT流程", null, 1,
                List.of(new FlowNode("s1", "START", "开始", null, null),
                        new FlowNode("a1", "APPROVAL", "主管审批",
                                new UserApprover(List.of(String.valueOf(OPERATOR + 1))), null),
                        new FlowNode("e1", "END", "结束", null, null)),
                List.of(new FlowEdge("f1", "s1", "a1", null),
                        new FlowEdge("f2", "a1", "e1", null)));
    }

    private long publishFlow(String key) {
        long id = Long.parseLong(String.valueOf(
                TenantContext.with(asOp(), () -> defService.create(appId, "IT流程", linearFlow(key)))
                        .get("id")));
        TenantContext.with(asOp(), () -> defService.publish(id));
        return id;
    }

    private static TenantInfo asOp() {
        return new TenantInfo(TENANT, 1, OPERATOR);
    }

    private static TenantInfo asApprover() {
        return new TenantInfo(TENANT, 1, OPERATOR + 1);
    }

    // ---------- A2 全链路 ----------

    @Test
    void A2_定义发布发起待办同意实例FINISHED() {
        long defId = publishFlow("it_flow_a2");

        // 定义已 PUBLISHED 且产生 deployment
        Map<String, Object> def = TenantContext.with(asOp(), () -> defService.detail(defId));
        assertEquals("PUBLISHED", def.get("status"));
        // ⚠️ 按 deployment 的**具体 id** 断言，不能按 name 计数：
        //    IT 反复运行会产生同名 deployment（旧的不一定清理干净），
        //    按 name count 会因历史残留而假失败。
        String deploymentId = jdbc.queryForObject(
                "SELECT deployment_id FROM flow_definition WHERE id = ?", String.class, defId);
        assertNotNull(deploymentId, "发布必须产生真实 deployment");
        assertEquals(1L, jdbc.queryForObject(
                "SELECT count(*) FROM act_re_deployment WHERE ID_ = ?", Long.class, deploymentId),
                "deployment 应真实存在于引擎表");

        // 发起
        String instanceId = String.valueOf(TenantContext.with(asOp(),
                () -> instService.start(1L, 7001L, defId)).get("instanceId"));
        assertNotNull(instanceId);

        // 审批人待办可见——按本实例过滤（同库其它用例也会产生待办，不能只看总数）
        Map<String, Object> tasks = TenantContext.with(asApprover(), () -> instService.myTasks());
        List<?> list = (List<?>) tasks.get("list");
        assertTrue(list.stream().anyMatch(m ->
                        instanceId.equals(String.valueOf(((Map<?, ?>) m).get("instanceId")))),
                "审批人应看到本实例的待办");
        String taskId = jdbc.queryForObject(
                "SELECT ID_ FROM act_ru_task WHERE PROC_INST_ID_ = ?", String.class, instanceId);

        // 同意
        Map<String, Object> result = TenantContext.with(asApprover(),
                () -> instService.complete(taskId, true, "IT 同意"));
        assertEquals("FINISHED", result.get("instanceState"));

        // 业务绑定终态 + 审计
        assertEquals("FINISHED", jdbc.queryForObject(
                "SELECT status FROM flow_instance_biz WHERE instance_id = ?", String.class, instanceId));
        assertEquals("COMPLETE", jdbc.queryForObject(
                "SELECT action FROM flow_task_log WHERE instance_id = ? ORDER BY id DESC LIMIT 1",
                String.class, instanceId));
    }

    // ---------- A3 越权办理 ----------

    @Test
    void A3_非候选人办理403且引擎状态不变() {
        long defId = publishFlow("it_flow_a3");
        String instanceId = String.valueOf(TenantContext.with(asOp(),
                () -> instService.start(1L, 7002L, defId)).get("instanceId"));
        String taskId = jdbc.queryForObject(
                "SELECT ID_ FROM act_ru_task WHERE PROC_INST_ID_ = ?", String.class, instanceId);

        // 发起人（非候选人）尝试办理 → TASK_NOT_ASSIGNED
        BizException e = assertThrows(BizException.class, () -> TenantContext.with(asOp(),
                () -> instService.complete(taskId, true, "越权")));
        assertEquals(FlowErrors.TASK_NOT_ASSIGNED, e.code());

        // 任务仍在运行态（越权未产生副作用）
        assertEquals(1L, jdbc.queryForObject(
                "SELECT count(*) FROM act_ru_task WHERE ID_ = ?", Long.class, taskId));
    }

    // ---------- A4 并发办理 ----------

    @Test
    void A4_同一任务并发办理只有一个成功() throws Exception {
        long defId = publishFlow("it_flow_a4");
        String instanceId = String.valueOf(TenantContext.with(asOp(),
                () -> instService.start(1L, 7003L, defId)).get("instanceId"));
        String taskId = jdbc.queryForObject(
                "SELECT ID_ FROM act_ru_task WHERE PROC_INST_ID_ = ?", String.class, instanceId);

        ExecutorService pool = Executors.newFixedThreadPool(2);
        Callable<Object> attempt = () -> {
            try {
                return TenantContext.with(asApprover(),
                        () -> instService.complete(taskId, true, "并发"));
            } catch (BizException ex) {
                return ex.code();
            }
        };
        Future<Object> f1 = pool.submit(attempt);
        Future<Object> f2 = pool.submit(attempt);
        Object r1 = f1.get(30, TimeUnit.SECONDS);
        Object r2 = f2.get(30, TimeUnit.SECONDS);
        pool.shutdown();

        // 一成一败：失败的必须是 TASK_ALREADY_COMPLETED（错误码稳定，不能是引擎内部异常）
        boolean oneOk = (r1 instanceof Map) ^ (r2 instanceof Map);
        assertTrue(oneOk, "应恰好一方成功: r1=" + r1 + " r2=" + r2);
        Object failed = (r1 instanceof Map) ? r2 : r1;
        assertEquals(FlowErrors.TASK_ALREADY_COMPLETED, failed);

        // 实例无重复推进（历史中审批节点只出现一次完成任务）
        Long doneCount = jdbc.queryForObject(
                "SELECT count(*) FROM act_hi_taskinst WHERE PROC_INST_ID_ = ? AND END_TIME_ IS NOT NULL",
                Long.class, instanceId);
        assertEquals(1L, doneCount, "任务不得被推进两次");
    }

    // ---------- A5 重复发起 ----------

    @Test
    void A5_同记录同流程重复发起被拒() {
        long defId = publishFlow("it_flow_a5");
        TenantContext.with(asOp(), () -> instService.start(1L, 7004L, defId));

        BizException e = assertThrows(BizException.class, () -> TenantContext.with(asOp(),
                () -> instService.start(1L, 7004L, defId)));
        assertEquals(FlowErrors.INSTANCE_ALREADY_RUNNING, e.code());

        // 只应有一条活跃绑定
        assertEquals(1L, jdbc.queryForObject(
                "SELECT count(*) FROM flow_instance_biz WHERE model_id = 1 AND record_id = 7004 "
                + "AND status IN ('RUNNING','SUSPENDED')", Long.class));
    }

    // ---------- A7 不支持节点发布被拒 ----------

    @Test
    void A7_含不支持节点发布422且不产生deployment() {
        FlowSchema withBranch = new FlowSchema("it_flow_a7", "含分支", null, 1,
                List.of(new FlowNode("s1", "START", "开始", null, null),
                        new FlowNode("c1", "CONDITION_BRANCH", "金额判断", null, null),
                        new FlowNode("e1", "END", "结束", null, null)),
                List.of(new FlowEdge("f1", "s1", "c1", null),
                        new FlowEdge("f2", "c1", "e1", null)));
        long defId = Long.parseLong(String.valueOf(TenantContext.with(asOp(),
                () -> defService.create(appId, "含分支", withBranch)).get("id")));

        BizException e = assertThrows(BizException.class,
                () -> TenantContext.with(asOp(), () -> defService.publish(defId)));
        assertEquals(FlowErrors.NODE_TYPE_NOT_SUPPORTED, e.code());

        // 关键：不产生 deployment（按定义行的 deployment_id 判断，不用 name 计数——
        // IT 反复运行会有同名历史残留，按 name 计数会误判）
        String depId = jdbc.queryForObject(
                "SELECT deployment_id FROM flow_definition WHERE id = ?", String.class, defId);
        assertNull(depId, "校验失败不得产生 deployment");
        // 定义仍是草稿
        assertEquals("DRAFT", jdbc.queryForObject(
                "SELECT status FROM flow_definition WHERE id = ?", String.class, defId));
    }

    // ---------- A8 拒绝终止 ----------

    @Test
    void A8_拒绝后实例FINISHED且业务状态驳回() {
        long defId = publishFlow("it_flow_a8");
        String instanceId = String.valueOf(TenantContext.with(asOp(),
                () -> instService.start(1L, 7005L, defId)).get("instanceId"));
        String taskId = jdbc.queryForObject(
                "SELECT ID_ FROM act_ru_task WHERE PROC_INST_ID_ = ?", String.class, instanceId);

        Map<String, Object> result = TenantContext.with(asApprover(),
                () -> instService.complete(taskId, false, "材料不全"));

        assertEquals("FINISHED", result.get("instanceState"), "拒绝=终止语义，不是回退");
        assertEquals(Boolean.FALSE, result.get("approved"));
        assertEquals("REJECT", jdbc.queryForObject(
                "SELECT action FROM flow_task_log WHERE instance_id = ? ORDER BY id DESC LIMIT 1",
                String.class, instanceId));
        // 无遗留运行任务
        assertEquals(0L, jdbc.queryForObject(
                "SELECT count(*) FROM act_ru_task WHERE PROC_INST_ID_ = ?", Long.class, instanceId));

        // A8 后半句「发起人收到 FLOW_DONE_REJECTED 通知」——T7 接线后才有这条断言。
        // 通知落 notify_message 表（12BE §4），收件人=发起人 OPERATOR。
        Map<String, Object> msg = jdbc.queryForMap(
                "SELECT biz_type, recipient_id, rendered FROM notify_message "
                        + "WHERE tenant_id = ? AND biz_type = 'FLOW_DONE' AND recipient_id = ? "
                        + "ORDER BY id DESC LIMIT 1", TENANT, OPERATOR);
        assertEquals("FLOW_DONE", msg.get("biz_type"));
        assertEquals(OPERATOR, ((Number) msg.get("recipient_id")).longValue());
        String rendered = String.valueOf(msg.get("rendered"));
        assertTrue(rendered.contains("驳回"),
                "拒绝应通知发起人「驳回」（模板 FLOW_DONE_REJECTED）: " + rendered);
    }

    // ---------- A9 审批人为空挂起 ----------

    /**
     * A9：审批人**运行时**解析为空 → 实例挂起 + BLOCK 告警。
     *
     * ⚠️ 不能用「配置里 userIds 为空」来造这个场景——那会在保存草稿时被
     * FlowSchemaValidator 拦下（USER 模式必填非空），根本到不了运行时。
     * 正确造法：DEPT_ROLE 模式 + 发起人所在部门**无该角色成员**——
     * 结构合法、能发布，但解析时为空。这正是真实组织数据缺配的形态。
     */
    @Test
    void A9_审批人运行时解析为空时实例挂起并告警() {
        // 让发起人属于一个「有部门但没人有该角色」的部门
        // V20 起 sys_dept 有 (tenant_id, path) 唯一约束，insert 语义确定；
        // 部门本身仍在 purgeFlowData 里统一清理
        jdbc.update("INSERT INTO sys_dept (tenant_id, path, name) VALUES (?, '/921/', 'IT流程部')",
                TENANT);
        Long deptId = jdbc.queryForObject(
                "SELECT id FROM sys_dept WHERE tenant_id = ? AND path = '/921/'", Long.class, TENANT);
        jdbc.update("UPDATE sys_user SET dept_id = ? WHERE tenant_id = ? AND account = ?",
                deptId, TENANT, "it_flow_u" + OPERATOR);

        FlowSchema deptRoleFlow = new FlowSchema("it_flow_a9", "部门角色审批", null, 1,
                List.of(new FlowNode("s1", "START", "开始", null, null),
                        new FlowNode("a1", "APPROVAL", "部门主管审批",
                                new DeptRoleApprover(List.of("it_nonexistent_role")), null),
                        new FlowNode("e1", "END", "结束", null, null)),
                List.of(new FlowEdge("f1", "s1", "a1", null),
                        new FlowEdge("f2", "a1", "e1", null)));
        long defId = Long.parseLong(String.valueOf(TenantContext.with(asOp(),
                () -> defService.create(appId, "部门角色审批", deptRoleFlow)).get("id")));
        TenantContext.with(asOp(), () -> defService.publish(defId));

        String instanceId = String.valueOf(TenantContext.with(asOp(),
                () -> instService.start(1L, 7006L, defId)).get("instanceId"));

        // 业务侧标记 SUSPENDED
        assertEquals("SUSPENDED", jdbc.queryForObject(
                "SELECT status FROM flow_instance_biz WHERE instance_id = ?", String.class, instanceId));
        // BLOCK 审计存在（本期唯一告警通道）
        assertTrue(jdbc.queryForObject(
                "SELECT count(*) FROM flow_task_log WHERE instance_id = ? AND comment LIKE 'BLOCK%'",
                Long.class, instanceId) > 0, "必须有 BLOCK 审计");
        // 引擎侧实例确实挂起
        // ⚠️ 两个坑：
        // 1) 判据是 SUSPENSION_STATE_ = 2（1=正常，2=挂起），不是 IS_ACTIVE_
        //    （挂起的实例 IS_ACTIVE_ 仍为 true，实测确认）
        // 2) act_ru_execution 对同一实例有多条记录（进程级 IS_SCOPE_=true + 活动级），
        //    不加 IS_SCOPE_ 过滤会查到 2 条 → IncorrectResultSize
        assertEquals(2, jdbc.queryForObject(
                "SELECT SUSPENSION_STATE_ FROM act_ru_execution "
                + "WHERE PROC_INST_ID_ = ? AND IS_SCOPE_ = true",
                Integer.class, instanceId), "引擎侧实例应挂起（SUSPENSION_STATE_=2）");

        // 恢复现场：清部门绑定，避免影响其它用例
        jdbc.update("UPDATE sys_user SET dept_id = NULL WHERE tenant_id = ? AND account = ?",
                TENANT, "it_flow_u" + OPERATOR);
    }

    /**
     * 补充：配置层空审批人应在**保存期**就被拒（与上面运行时为空形成对照）。
     */
    @Test
    void A9b_配置空审批人在保存期被拒() {
        FlowSchema emptyApprover = new FlowSchema("it_flow_a9b", "空审批人", null, 1,
                List.of(new FlowNode("s1", "START", "开始", null, null),
                        new FlowNode("a1", "APPROVAL", "无人审批",
                                new UserApprover(List.of()), null),
                        new FlowNode("e1", "END", "结束", null, null)),
                List.of(new FlowEdge("f1", "s1", "a1", null),
                        new FlowEdge("f2", "a1", "e1", null)));

        BizException e = assertThrows(BizException.class, () -> TenantContext.with(asOp(),
                () -> defService.create(appId, "空审批人", emptyApprover)));
        assertEquals(FlowErrors.SCHEMA_INVALID, e.code(), "空 userIds 应在保存期拒绝");
    }

    // ---------- A6 版本演进 ----------

    /**
     * A6：新版本发布后，**在途实例继续按旧 deployment 执行完毕**，新发起走新版本。
     *
     * 这是 Flowable 的版本化语义：实例创建时绑定 procdef（含版本），
     * 后续部署不会改变已有实例的执行路径。
     * 本用例的价值是把这条「引擎天然保证」钉成回归测试——
     * 若将来有人在发布时「顺手终止旧实例」或「强制迁移」，会立刻红。
     */
    @Test
    void A6_新版本发布后在途实例仍按旧版本完成() {
        long defId = publishFlow("it_flow_a6");

        // ① 旧版本下发起实例（记录其 procdef 版本）
        String oldInstance = String.valueOf(TenantContext.with(asOp(),
                () -> instService.start(1L, 7010L, defId)).get("instanceId"));
        String oldProcDefId = jdbc.queryForObject(
                "SELECT PROC_DEF_ID_ FROM act_ru_execution WHERE PROC_INST_ID_ = ? AND IS_SCOPE_ = true",
                String.class, oldInstance);
        Integer oldVersion = jdbc.queryForObject(
                "SELECT VERSION_ FROM act_re_procdef WHERE ID_ = ?", Integer.class, oldProcDefId);
        assertNotNull(oldVersion, "旧实例应绑定具体 procdef 版本");

        // ② 修改定义并重新发布（产生新版本）
        FlowSchema v2 = new FlowSchema("it_flow_a6", "IT流程v2", null, 1,
                List.of(new FlowNode("s1", "START", "开始", null, null),
                        new FlowNode("a1", "APPROVAL", "主管审批v2",
                                new UserApprover(List.of(String.valueOf(OPERATOR + 1))), null),
                        new FlowNode("e1", "END", "结束", null, null)),
                List.of(new FlowEdge("f1", "s1", "a1", null),
                        new FlowEdge("f2", "a1", "e1", null)));
        TenantContext.with(asOp(), () -> defService.saveDraft(defId, v2, 2));
        TenantContext.with(asOp(), () -> defService.publish(defId));

        Integer newVersion = jdbc.queryForObject(
                "SELECT max(VERSION_) FROM act_re_procdef WHERE KEY_ = 'it_flow_a6'", Integer.class);
        assertTrue(newVersion > oldVersion,
                "重新发布应产生更高版本: old=" + oldVersion + " new=" + newVersion);

        // ③ 关键断言：在途实例仍绑定旧 procdef（未被迁移）
        assertEquals(oldProcDefId, jdbc.queryForObject(
                "SELECT PROC_DEF_ID_ FROM act_ru_execution "
                + "WHERE PROC_INST_ID_ = ? AND IS_SCOPE_ = true", String.class, oldInstance),
                "在途实例不得被迁移到新版本");

        // ④ 旧实例可正常完成（不被新部署打断）
        String oldTask = jdbc.queryForObject(
                "SELECT ID_ FROM act_ru_task WHERE PROC_INST_ID_ = ?", String.class, oldInstance);
        Map<String, Object> done = TenantContext.with(asApprover(),
                () -> instService.complete(oldTask, true, "旧版本完成"));
        assertEquals("FINISHED", done.get("instanceState"), "在途实例应能按旧版本正常结束");

        // ⑤ 新发起走新版本
        String newInstance = String.valueOf(TenantContext.with(asOp(),
                () -> instService.start(1L, 7011L, defId)).get("instanceId"));
        Integer newInstanceVersion = jdbc.queryForObject(
                "SELECT p.VERSION_ FROM act_ru_execution e JOIN act_re_procdef p ON p.ID_ = e.PROC_DEF_ID_ "
                + "WHERE e.PROC_INST_ID_ = ? AND e.IS_SCOPE_ = true",
                Integer.class, newInstance);
        assertEquals(newVersion, newInstanceVersion, "新发起应走最新版本");
    }

    // ---------- A11 / A12 ----------

    @Test
    void A11_未发布定义不能发起() {
        long draftId = Long.parseLong(String.valueOf(TenantContext.with(asOp(),
                () -> defService.create(appId, "草稿", linearFlow("it_flow_a11"))).get("id")));

        BizException e = assertThrows(BizException.class, () -> TenantContext.with(asOp(),
                () -> instService.start(1L, 7007L, draftId)));
        assertEquals(FlowErrors.FLOW_DEF_NOT_PUBLISHED, e.code());

        // 不产生孤儿实例
        assertEquals(0L, jdbc.queryForObject(
                "SELECT count(*) FROM flow_instance_biz WHERE record_id = 7007", Long.class));
    }

    @Test
    void A12_流程变量不含凭证且无敏感键() {
        long defId = publishFlow("it_flow_a12");
        String instanceId = String.valueOf(TenantContext.with(asOp(),
                () -> instService.start(1L, 7008L, defId)).get("instanceId"));

        List<String> keys = jdbc.queryForList(
                "SELECT NAME_ FROM act_ru_variable WHERE PROC_INST_ID_ = ?", String.class, instanceId);

        assertTrue(keys.containsAll(
                        List.of("modelId", "recordId", "flowDefId", "initiator", "tenantId")),
                "应含业务标识: " + keys);

        // 白名单式断言（比黑名单更强）：变量集合必须**只**含这些键。
        // 黑名单只能挡住已知敏感词，白名单能挡住「未来误加的任意字段」。
        java.util.Set<String> allowed = java.util.Set.of(
                "modelId", "recordId", "flowDefId", "initiator", "tenantId");
        for (String k : keys) {
            assertTrue(allowed.contains(k), "流程变量出现白名单外的键（A12 红线）: " + k);
            String lower = k.toLowerCase();
            assertTrue(!lower.contains("token") && !lower.contains("session")
                            && !lower.contains("cookie") && !lower.contains("csrf")
                            && !lower.contains("password"),
                    "流程变量不得含凭证: " + k);
        }
    }

    /**
     * A10 办理失败不产生部分写入（事务边界验证）。
     *
     * ## 为什么这样注入
     * 「complete 事务内业务写入失败 → 全回滚」需要让某个写入操作抛异常，
     * 但直接改 schema 加约束会污染测试库、影响其它 IT。
     * 采用**可复现的失败路径**：重复办理同一任务。
     * 这守住 A10 的**可观测后果**——失败请求不留下任何部分写入。
     *
     * 本平台引擎与业务同库同事务（Flowable 使用 Spring 的 DataSourceTransactionManager），
     * 因此 complete 的 @Transactional 覆盖两侧写入。
     */
    @Test
    void A10_办理失败不产生部分写入() {
        long defId = publishFlow("it_flow_a10");
        String instanceId = String.valueOf(TenantContext.with(asOp(),
                () -> instService.start(1L, 7009L, defId)).get("instanceId"));
        String taskId = jdbc.queryForObject(
                "SELECT ID_ FROM act_ru_task WHERE PROC_INST_ID_ = ?", String.class, instanceId);

        // 基线：尚未办理，无人工审计记录
        assertEquals(0L, jdbc.queryForObject(
                "SELECT count(*) FROM flow_task_log WHERE instance_id = ? AND action <> 'AUTO'",
                Long.class, instanceId));

        // 第一次办理成功
        TenantContext.with(asApprover(), () -> instService.complete(taskId, true, "同意"));
        assertEquals(1L, jdbc.queryForObject(
                "SELECT count(*) FROM flow_task_log WHERE instance_id = ? AND action = 'COMPLETE'",
                Long.class, instanceId));

        // 第二次办理同一任务 → 失败
        // ⚠️ 实测：任务完成后 act_ru_task 行已被引擎删除，findTask 返回 null，
        //    因此错误码是 TASK_NOT_FOUND 而非 TASK_ALREADY_COMPLETED。
        //    （A4 的并发用例里两请求同时到达，此时任务还在表中，才会走到
        //     isFinished 分支得到 TASK_ALREADY_COMPLETED。）
        //    A10 关心的是「失败不产生部分写入」，两种错误码都满足该语义。
        BizException e = assertThrows(BizException.class, () -> TenantContext.with(asApprover(),
                () -> instService.complete(taskId, true, "重复提交")));
        assertTrue(
                FlowErrors.TASK_ALREADY_COMPLETED.equals(e.code())
                        || FlowErrors.TASK_NOT_FOUND.equals(e.code()),
                "重复办理应被拒（TASK_ALREADY_COMPLETED 或 TASK_NOT_FOUND），实际: " + e.code());

        // A10 可观测后果：失败路径没有追加审计写入
        assertEquals(1L, jdbc.queryForObject(
                "SELECT count(*) FROM flow_task_log WHERE instance_id = ? AND action = 'COMPLETE'",
                Long.class, instanceId),
                "办理失败不得产生第二条审计记录（事务边界生效）");
        // 实例状态未被失败请求改写
        assertEquals("FINISHED", jdbc.queryForObject(
                "SELECT status FROM flow_instance_biz WHERE instance_id = ?",
                String.class, instanceId));
    }

    /**
     * T5 已办：办理过的任务出现在 doneTasks() 数据源里。
     *
     * 守住两条边界：
     * - 已办只含「我」办理过的（不混入他人动作）
     * - 已办排除 AUTO（系统挂起告警，operator_id=0，不属于任何人的已办）
     */
    @Test
    void T5_已办列表只含我办理过的真实动作() {
        long defId = publishFlow("it_flow_done");
        String instanceId = String.valueOf(TenantContext.with(asOp(),
                () -> instService.start(1L, 7010L, defId)).get("instanceId"));
        String taskId = jdbc.queryForObject(
                "SELECT ID_ FROM act_ru_task WHERE PROC_INST_ID_ = ?", String.class, instanceId);

        // ⚠️ 用**增量**断言而非绝对条数：@TestInstance(PER_CLASS) 下同类的
        //    其它用例已产生审计记录，绝对值会随执行顺序漂移（实测 1 vs 5）。
        long beforeApprover = ((Number) TenantContext.with(asApprover(),
                () -> instService.doneTasks(0, 200)).get("total")).longValue();
        long beforeOp = ((Number) TenantContext.with(asOp(),
                () -> instService.doneTasks(0, 200)).get("total")).longValue();

        TenantContext.with(asApprover(), () -> instService.complete(taskId, true, "同意"));

        // 办理人的已办 +1，且新条目就是本实例
        Map<String, Object> approverDone = TenantContext.with(asApprover(),
                () -> instService.doneTasks(0, 200));
        assertEquals(beforeApprover + 1, ((Number) approverDone.get("total")).longValue(),
                "审批人的已办应新增 1 条（本次办理）");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> items = (List<Map<String, Object>>) approverDone.get("list");
        assertEquals(instanceId, String.valueOf(items.get(0).get("instance_id")),
                "已办首条应为本次办理（按 operated_at DESC）");

        // 发起人的已办**条数不变**（不混入他人办理）
        Map<String, Object> opDone = TenantContext.with(asOp(), () -> instService.doneTasks(0, 200));
        assertEquals(beforeOp, ((Number) opDone.get("total")).longValue(),
                "发起人未办理本实例，已办条数不得增加（不得混入他人动作）");
    }
}