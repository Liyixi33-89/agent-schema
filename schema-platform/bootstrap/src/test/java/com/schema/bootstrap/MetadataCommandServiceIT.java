package com.schema.bootstrap;

import com.schema.metadata.application.MetadataCommandService;
import com.schema.metadata.domain.model.ChangeOp;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * M2 集成测试（真实 PG，01BE §7 硬性要求）：
 * 字段状态机 / 乐观锁并发 / 回滚 / confirmToken 四元组 / 租户隔离。
 * 前置：本地 docker compose up -d postgres（compose.yaml）；CI 走 Testcontainers（M5 前接入）。
 */
@SpringBootTest(classes = com.schema.bootstrap.SchemaApplication.class)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(properties = {
        "spring.datasource.url=jdbc:postgresql://localhost:5432/schema_dev",
        "spring.datasource.username=schema_dev",
        "spring.datasource.password=schema_local_only",
        "spring.flyway.clean-disabled=false"
})
class MetadataCommandServiceIT {

    @Autowired
    private MetadataCommandService service;

    @Autowired
    private JdbcTemplate jdbc;

    private long modelId;

    @BeforeAll
    void warmup() {
        // 清理本测试的历史数据（幂等重跑）
        jdbc.update("DELETE FROM meta_field_reference");
        jdbc.update("DELETE FROM meta_confirm_token");
        jdbc.update("DELETE FROM meta_schema_version");
        jdbc.update("DELETE FROM meta_field");
        jdbc.update("DELETE FROM meta_model");
    }

    @BeforeEach
    void setUp() {
        TenantContext.with(new TenantInfo(1, 1, 1), () -> {
            modelId = Long.parseLong((String) service.createModel("order_" + System.nanoTime(), "订单管理", null).get("id"));
            return null;
        });
    }

    @AfterEach
    void cleanup() {
        TenantContext.clear();
    }

    private long createModelFor(long tenantId) {
        return TenantContext.with(new TenantInfo(tenantId, 1, 1), () ->
                Long.parseLong((String) service.createModel("m_" + tenantId + "_" + System.nanoTime(), "T", null).get("id")));
    }

    // ---------- 01BE §7：字段状态机 ----------

    @Test
    void deletedFieldNeverReturnedByDefaultApi() {
        saveTwoFields();
        // 删除走两段式
        Map<String, Object> pre = precheck(List.of(new ChangeOp.DeleteField("amount")));
        String token = (String) pre.get("confirmToken");
        TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.saveSchema(modelId, List.of(new ChangeOp.DeleteField("amount")), 2, token, null));

        Map<String, Object> detail = TenantContext.with(new TenantInfo(1, 1, 1), () -> service.getModel(modelId));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> fields = (List<Map<String, Object>>) detail.get("fields");
        // 详情默认响应按 A.1 返回全部字段（fieldStatus 标记），但活跃集合必须排除 DELETED
        boolean deletedVisibleAsActive = fields.stream().anyMatch(f ->
                "amount".equals(f.get("fieldKey")) && !"DELETED".equals(f.get("fieldStatus")));
        assertFalse(deletedVisibleAsActive, "DELETED 字段不得以活跃形态出现在默认响应");

        // 物理行仍在（DDL 铁律：永不物理删除）
        Long rowCount = jdbc.queryForObject(
                "SELECT count(*) FROM meta_field WHERE model_id=? AND field_key='amount'", Long.class, modelId);
        assertEquals(1L, rowCount, "meta_field 行必须保留（永不 DELETE）");
    }

    // ---------- 01BE §7：乐观锁 ----------

    @Test
    void optimisticLockRejectsStaleBaseVersion() {
        Map<String, Object> pre = precheck(List.of(addAmount()));
        String token = (String) pre.get("confirmToken");

        // 第一方提交成功（v1→v2）
        TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.saveSchema(modelId, List.of(addAmount()), 1, token, null));

        // 第二方用过期 baseVersion=1 再提交：409
        Map<String, Object> pre2 = precheck(List.of(addStatus()));
        String token2 = (String) pre2.get("confirmToken");
        BizException e = TenantContext.with(new TenantInfo(1, 1, 1), () -> {
            try {
                service.saveSchema(modelId, List.of(addStatus()), 1, token2, null);
                return null;
            } catch (BizException ex) {
                return ex;
            }
        });
        assertNotNull(e, "过期 baseVersion 必须被拒");
        assertEquals("MODEL_VERSION_CONFLICT", e.code());
        assertEquals(2, e.details().get("serverVersion"), "409 必须携带 serverVersion（前端三方对比依赖）");
    }

    // ---------- 01BE §7：confirmToken ----------

    @Test
    void confirmTokenSingleConsumptionAndBinding() {
        Map<String, Object> pre = precheck(List.of(addAmount()));
        String token = (String) pre.get("confirmToken");

        // 篡改 changes 后重放：binding hash 不一致被拒（token 不消费）
        BizException e1 = expectBiz(() -> service.saveSchema(modelId, List.of(addStatus()), 1, token, null));
        assertEquals("CONFIRM_TOKEN_INVALID", e1.code());

        // 原样提交成功（v1→v2）
        TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.saveSchema(modelId, List.of(addAmount()), 1, token, null));

        // 二次消费拒绝：用新 baseVersion 提交同 token（绕开乐观锁，直击 token 幂等）
        BizException e2 = expectBiz(() -> service.saveSchema(modelId, List.of(addAmount()), 2, token, null));
        assertEquals("CONFIRM_TOKEN_INVALID", e2.code(), "token 一次性消费");
    }

    @Test
    void highRiskDeleteRequiresModelNameMatch() {
        saveTwoFields();
        // 登记 3 个 PAGE 引用 → 删除触发 TYPE_MODEL_NAME
        for (long pageId = 101; pageId <= 103; pageId++) {
            final long pid = pageId;
            TenantContext.with(new TenantInfo(1, 1, 1), () -> {
                service.registerReference(modelId, "amount", "PAGE", pid);
                return null;
            });
        }
        Map<String, Object> pre = TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.precheck(modelId, List.of(new ChangeOp.DeleteField("amount"))));
        assertEquals("TYPE_MODEL_NAME", pre.get("confirmMode"), "删被 ≥3 页面引用的字段必须 TYPE_MODEL_NAME");
        String token = (String) pre.get("confirmToken");

        // confirmValue 错误 → 422 且 token 不消费
        BizException wrong = expectBiz(() -> service.saveSchema(modelId,
                List.of(new ChangeOp.DeleteField("amount")), 2, token, "错误的名字"));
        assertEquals("CONFIRM_TOKEN_INVALID", wrong.code());

        // confirmValue 正确 → 成功
        String modelName = TenantContext.with(new TenantInfo(1, 1, 1), () -> {
            Map<String, Object> d = service.getModel(modelId);
            return (String) d.get("name");
        });
        Map<String, Object> saved = TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.saveSchema(modelId, List.of(new ChangeOp.DeleteField("amount")), 2, token, modelName));
        assertEquals(3, saved.get("version"));
    }

    // ---------- 01BE §7：回滚 ----------

    @Test
    void rollbackRestoresFieldAndMarksRollbackFrom() {
        saveTwoFields(); // v2: amount + status
        // v3: 删除 amount
        Map<String, Object> pre = precheck(List.of(new ChangeOp.DeleteField("amount")));
        TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.saveSchema(modelId, List.of(new ChangeOp.DeleteField("amount")),
                        2, (String) pre.get("confirmToken"), null));

        // 回滚到 v2（独立 precheck + confirmValue）
        Map<String, Object> rbPre = TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.rollbackPrecheck(modelId, 2));
        String rbToken = (String) rbPre.get("confirmToken");
        String modelName = "订单管理";
        Map<String, Object> rb = TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.rollback(modelId, 2, rbToken, modelName));
        assertEquals(4, rb.get("version"), "回滚产生新版本 v4");

        // 字段复活（草稿态：不自动 promote）
        Map<String, Object> detail = TenantContext.with(new TenantInfo(1, 1, 1), () -> service.getModel(modelId));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> fields = (List<Map<String, Object>>) detail.get("fields");
        boolean amountActive = fields.stream().anyMatch(f ->
                "amount".equals(f.get("fieldKey")) && "ACTIVE".equals(f.get("fieldStatus")));
        assertTrue(amountActive, "回滚后字段必须复活为 ACTIVE");

        // 新版本标记 rollback_from=2
        Map<String, Object> versionsResp = TenantContext.with(new TenantInfo(1, 1, 1), () -> service.listVersions(modelId));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> vlist = (List<Map<String, Object>>) versionsResp.get("list");
        Map<String, Object> v4 = vlist.stream().filter(v -> Integer.valueOf(4).equals(v.get("version")))
                .findFirst().orElseThrow();
        assertEquals(2, v4.get("rollbackFrom"), "回滚版本必须标记 rollback_from");
    }

    // ---------- 01BE §7 / A6：租户隔离 ----------

    @Test
    void forgedTenantContextIsRejected() {
        long victimModel = createModelFor(1); // 租户 1 的模型
        // 伪造租户 2 上下文访问
        BizException e = TenantContext.with(new TenantInfo(2, 1, 1), () -> {
            try {
                service.getModel(victimModel);
                return null;
            } catch (BizException ex) {
                return ex;
            }
        });
        assertNotNull(e, "跨租户读取必须被拦截");
        assertEquals("MODEL_NOT_FOUND", e.code(), "不给数据线索（同 404 响应）");
    }

    @Test
    void computedCircularDependencyRejected() {
        Map<String, Object> fieldA = Map.of(
                "label", "A", "type", "computed",
                "computed", Map.of("expr", Map.of("kind", "expr", "source", "1"),
                        "dependsOn", List.of("b"), "persistMode", "READ_TIME"));
        Map<String, Object> fieldB = Map.of(
                "label", "B", "type", "computed",
                "computed", Map.of("expr", Map.of("kind", "expr", "source", "2"),
                        "dependsOn", List.of("a"), "persistMode", "READ_TIME"));
        Map<String, Object> pre = precheck(List.of(
                new ChangeOp.AddField("a", fieldA),
                new ChangeOp.AddField("b", fieldB)));
        BizException e = expectBiz(() -> service.saveSchema(modelId,
                List.of(new ChangeOp.AddField("a", fieldA), new ChangeOp.AddField("b", fieldB)),
                1, (String) pre.get("confirmToken"), null));
        assertEquals("CIRCULAR_DEPENDENCY", e.code(), "依赖成环必须 422");
    }

    // ---------- 保存校验器（01BE §4.2 步骤 4）：类型相关性 ----------

    @Test
    void enumOptionsRejectedOnNonEnumType() {
        ChangeOp.AddField bad = new ChangeOp.AddField("score",
                Map.of("label", "评分", "type", "number", "enumOptions", List.of(Map.of("value", "a", "label", "A"))));
        BizException e = expectBiz(() -> service.precheck(modelId, List.of(bad)));
        assertEquals("FIELD_CONFIG_INVALID", e.code(), "非 enum 字段携带 enumOptions 必须 422");
    }

    @Test
    void enumOptionDuplicateValueRejected() {
        ChangeOp.AddField bad = new ChangeOp.AddField("grade", Map.of(
                "label", "等级", "type", "enum",
                "enumOptions", List.of(
                        Map.of("value", "A", "label", "优", "status", "ACTIVE"),
                        Map.of("value", "A", "label", "良", "status", "ACTIVE"))));
        BizException e = expectBiz(() -> service.precheck(modelId, List.of(bad)));
        assertEquals("FIELD_CONFIG_INVALID", e.code(), "enumOptions.value 重复必须 422");
    }

    @Test
    void relationTargetMustExistInTenant() {
        // 跨租户目标：租户 1 引用租户 2 的模型 ID → 同判不存在（RELATION_TARGET_NOT_FOUND）
        long otherTenantModel = createModelFor(2);
        ChangeOp.AddField bad = new ChangeOp.AddField("buyer", Map.of(
                "label", "买方", "type", "relation",
                "relation", Map.of("targetModelId", String.valueOf(otherTenantModel),
                        "cardinality", "1:n", "cascade", "FORBID")));
        BizException e = expectBiz(() -> service.precheck(modelId, List.of(bad)));
        assertEquals("RELATION_TARGET_NOT_FOUND", e.code(), "跨租户关系目标必须被拒");

        // 同租户目标：通过
        long ownModel = createModelFor(1);
        ChangeOp.AddField ok = new ChangeOp.AddField("seller", Map.of(
                "label", "卖方", "type", "relation",
                "relation", Map.of("targetModelId", String.valueOf(ownModel),
                        "cardinality", "1:n", "cascade", "FORBID")));
        TenantContext.with(new TenantInfo(1, 1, 1), () -> {
            service.precheck(modelId, List.of(ok));
            return null;
        });
    }

    @Test
    void computedConfigStructureValidated() {
        // persistMode 非法
        ChangeOp.AddField bad = new ChangeOp.AddField("total", Map.of(
                "label", "合计", "type", "computed",
                "computed", Map.of("expr", Map.of("kind", "expr", "source", "1+1"),
                        "dependsOn", List.of(), "persistMode", "ALWAYS")));
        BizException e = expectBiz(() -> service.precheck(modelId, List.of(bad)));
        assertEquals("FIELD_CONFIG_INVALID", e.code(), "computed.persistMode 非法必须 422");
    }

    // ---------- 删除模型两段式（01BE §4.1/§4.3） ----------

    @Test
    void deleteModelRequiresModelNameConfirm() {
        // precheck：固定 TYPE_MODEL_NAME
        Map<String, Object> pre = TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.deleteModelPrecheck(modelId));
        assertEquals("TYPE_MODEL_NAME", pre.get("confirmMode"), "删模型必须 TYPE_MODEL_NAME");
        String token = (String) pre.get("confirmToken");

        // confirmValue 错误 → 拒绝且 token 不消费
        BizException wrong = expectBizVoid(() -> service.deleteModelConfirm(modelId, token, "错误的名字"));
        assertEquals("CONFIRM_TOKEN_INVALID", wrong.code());

        // confirmValue 正确 → 删除成功
        TenantContext.with(new TenantInfo(1, 1, 1), () -> {
            service.deleteModelConfirm(modelId, token, "订单管理");
            return null;
        });
        // 默认列表不再返回
        Map<String, Object> list = TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.listModels(null, false));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> items = (List<Map<String, Object>>) list.get("list");
        assertTrue(items.stream().noneMatch(m -> String.valueOf(m.get("id")).equals(String.valueOf(modelId))),
                "删除后默认列表不得返回该模型");

        // token 一次性：重放被拒
        BizException replay = expectBizVoid(() -> service.deleteModelConfirm(modelId, token, "订单管理"));
        assertEquals("CONFIRM_TOKEN_INVALID", replay.code());
    }

    // ---------- 回滚删除语义还原（快照含 fieldStatus） ----------

    @Test
    void rollbackRestoresDeletionSemantics() {
        saveTwoFields(); // v2: amount + status
        // v3: 删除 amount
        Map<String, Object> pre = precheck(List.of(new ChangeOp.DeleteField("amount")));
        TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.saveSchema(modelId, List.of(new ChangeOp.DeleteField("amount")),
                        2, (String) pre.get("confirmToken"), null));
        // v4: 加回 amount（新定义）——注意 ADD_FIELD 要求字段不在集合中，但软删后 findField 存在（DELETED）
        // validateChanges 的 FIELD_KEY_DUPLICATED 只对「存在」抛——先复活流程见回滚，此处直接走回滚语义验证

        // 回滚到 v2：amount 复活（草稿态）
        Map<String, Object> rbPre = TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.rollbackPrecheck(modelId, 2));
        String modelName = "订单管理";
        TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.rollback(modelId, 2, (String) rbPre.get("confirmToken"), modelName));
        // v5: 回滚到 v3（amount 为 DELETED 态）——复活后的 amount 必须重新删除（还原删除语义）
        Map<String, Object> rbPre2 = TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.rollbackPrecheck(modelId, 3));
        TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.rollback(modelId, 3, (String) rbPre2.get("confirmToken"), modelName));

        Map<String, Object> detail = TenantContext.with(new TenantInfo(1, 1, 1), () -> service.getModel(modelId));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> fields = (List<Map<String, Object>>) detail.get("fields");
        Map<String, Object> amount = fields.stream()
                .filter(f -> "amount".equals(f.get("fieldKey"))).findFirst().orElseThrow();
        assertEquals("DELETED", amount.get("fieldStatus"), "回滚到含 DELETED 的版本必须还原删除语义");
    }

    // ---------- 乐观锁：真实并发竞争 ----------

    @Test
    void concurrentSaveOnlyOneWins() throws Exception {
        // 两方各自 precheck 同一 baseVersion 的不同变更
        Map<String, Object> pre1 = precheck(List.of(addAmount()));
        Map<String, Object> pre2 = precheck(List.of(addStatus()));
        String token1 = (String) pre1.get("confirmToken");
        String token2 = (String) pre2.get("confirmToken");

        java.util.concurrent.CountDownLatch start = new java.util.concurrent.CountDownLatch(1);
        java.util.List<Throwable> errors = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
        java.util.concurrent.atomic.AtomicInteger wins = new java.util.concurrent.atomic.AtomicInteger();
        Runnable racer = () -> {
            try {
                start.await();
                TenantContext.with(new TenantInfo(1, 1, 1), () -> {
                    try {
                        if (Thread.currentThread().getName().contains("racer-1")) {
                            service.saveSchema(modelId, List.of(addAmount()), 1, token1, null);
                        } else {
                            service.saveSchema(modelId, List.of(addStatus()), 1, token2, null);
                        }
                        wins.incrementAndGet();
                        return null;
                    } catch (BizException ex) {
                        if ("MODEL_VERSION_CONFLICT".equals(ex.code())) {
                            return null; // 预期输家
                        }
                        throw ex;
                    }
                });
            } catch (Throwable t) {
                errors.add(t);
            }
        };
        Thread t1 = new Thread(racer, "racer-1");
        Thread t2 = new Thread(racer, "racer-2");
        t1.start();
        t2.start();
        start.countDown();
        t1.join(10_000);
        t2.join(10_000);
        assertTrue(errors.isEmpty(), "并发保存不应产生预期外异常: " + errors);
        assertEquals(1, wins.get(), "同一 baseVersion 并发提交恰好一方成功（乐观锁）");
    }

    // ---------- COMPUTED 引用登记（01BE §4.5：保存时由本服务登记） ----------

    @Test
    void computedReferencesRegisteredOnSave() {
        // 加普通字段 + 计算字段（依赖普通字段）
        Map<String, Object> amountDef = Map.of("label", "金额", "type", "number");
        Map<String, Object> totalDef = Map.of(
                "label", "翻倍", "type", "computed",
                "computed", Map.of("expr", Map.of("kind", "expr", "source", "amount * 2"),
                        "dependsOn", List.of("amount"), "persistMode", "READ_TIME"));
        Map<String, Object> pre = precheck(List.of(
                new ChangeOp.AddField("amount", amountDef),
                new ChangeOp.AddField("double_amount", totalDef)));
        TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.saveSchema(modelId, List.of(
                        new ChangeOp.AddField("amount", amountDef),
                        new ChangeOp.AddField("double_amount", totalDef)),
                        1, (String) pre.get("confirmToken"), null));

        // 引用表登记：amount ← double_amount（COMPUTED）
        Long refs = jdbc.queryForObject(
                "SELECT count(*) FROM meta_field_reference WHERE model_id=? AND field_key='amount' "
                        + "AND ref_type='COMPUTED'", Long.class, modelId);
        assertEquals(1L, refs, "计算字段保存后必须登记 COMPUTED 引用");

        // 删除被依赖字段时 precheck 必须给出 COMPUTED_REF 高风险
        Map<String, Object> delPre = precheck(List.of(new ChangeOp.DeleteField("amount")));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> risks = (List<Map<String, Object>>) delPre.get("risks");
        assertTrue(risks.stream().anyMatch(r -> "COMPUTED_REF".equals(r.get("type"))),
                "删除被计算字段依赖的字段必须暴露 COMPUTED_REF 风险");
    }

    // ---------- token 模型绑定（2026-10-29 收口：跨模型挪用拒绝） ----------

    @Test
    void tokenCannotBeReusedAcrossModels() {
        // 模型 A 签发 token（同变更内容、同 baseVersion）
        long modelA = modelId;
        Map<String, Object> preA = precheck(List.of(addAmount()));
        String tokenA = (String) preA.get("confirmToken");

        // 模型 B 构造完全相同的变更 + baseVersion → 挪用 A 的 token 必须被拒
        long modelB = TenantContext.with(new TenantInfo(1, 1, 1), () ->
                Long.parseLong((String) service.createModel("victim_" + System.nanoTime(), "B", null).get("id")));
        BizException e = TenantContext.with(new TenantInfo(1, 1, 1), () -> {
            try {
                service.saveSchema(modelB, List.of(addAmount()), 1, tokenA, null);
                return null;
            } catch (BizException ex) {
                return ex;
            }
        });
        assertNotNull(e, "跨模型挪用 token 必须被拒");
        assertEquals("CONFIRM_TOKEN_INVALID", e.code(), "modelId 绑定校验");

        // 原 token 在模型 A 上仍可正常消费（挪用失败不消费）
        TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.saveSchema(modelA, List.of(addAmount()), 1, tokenA, null));
    }

    // ---------- COMPUTED 引用全量重建（2026-10-29 收口：无残留） ----------

    @Test
    void computedReferencesRebuiltWithoutResidue() {
        // v2: amount + double_amount（依赖 amount）
        Map<String, Object> amountDef = Map.of("label", "金额", "type", "number");
        Map<String, Object> totalDef = Map.of(
                "label", "翻倍", "type", "computed",
                "computed", Map.of("expr", Map.of("kind", "expr", "source", "amount * 2"),
                        "dependsOn", List.of("amount"), "persistMode", "READ_TIME"));
        Map<String, Object> pre = precheck(List.of(
                new ChangeOp.AddField("amount", amountDef),
                new ChangeOp.AddField("double_amount", totalDef)));
        TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.saveSchema(modelId, List.of(
                        new ChangeOp.AddField("amount", amountDef),
                        new ChangeOp.AddField("double_amount", totalDef)),
                        1, (String) pre.get("confirmToken"), null));

        Long refs = jdbc.queryForObject(
                "SELECT count(*) FROM meta_field_reference WHERE model_id=? AND ref_type='COMPUTED'",
                Long.class, modelId);
        assertEquals(1L, refs, "保存后登记 amount ← double_amount");

        // v3: MODIFY 改 dependsOn → amount 改为 amount2——旧引用必须被清除
        Map<String, Object> amount2Def = Map.of("label", "金额2", "type", "number");
        Map<String, Object> pre2 = precheck(List.of(
                new ChangeOp.AddField("amount2", amount2Def),
                new ChangeOp.ModifyField("double_amount", Map.of("computed",
                        Map.of("expr", Map.of("kind", "expr", "source", "amount2 * 2"),
                                "dependsOn", List.of("amount2"), "persistMode", "READ_TIME")))));
        TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.saveSchema(modelId, List.of(
                        new ChangeOp.AddField("amount2", amount2Def),
                        new ChangeOp.ModifyField("double_amount", Map.of("computed",
                                Map.of("expr", Map.of("kind", "expr", "source", "amount2 * 2"),
                                        "dependsOn", List.of("amount2"), "persistMode", "READ_TIME")))),
                        2, (String) pre2.get("confirmToken"), null));

        Long staleAmount = jdbc.queryForObject(
                "SELECT count(*) FROM meta_field_reference WHERE model_id=? AND field_key='amount' "
                        + "AND ref_type='COMPUTED'", Long.class, modelId);
        assertEquals(0L, staleAmount, "改 dependsOn 后旧依赖不得残留（否则删除 amount 误报风险）");
        Long newRefs = jdbc.queryForObject(
                "SELECT count(*) FROM meta_field_reference WHERE model_id=? AND field_key='amount2' "
                        + "AND ref_type='COMPUTED'", Long.class, modelId);
        assertEquals(1L, newRefs, "新依赖登记到位");

        // 删除 amount 的 precheck 不再误报 COMPUTED_REF
        Map<String, Object> delPre = precheck(List.of(new ChangeOp.DeleteField("amount")));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> risks = (List<Map<String, Object>>) delPre.get("risks");
        assertTrue(risks.stream().noneMatch(r -> "COMPUTED_REF".equals(r.get("type"))),
                "依赖已改走后删除旧字段不得误报 COMPUTED_REF");
    }

    // ---------- 辅助 ----------

    private Map<String, Object> precheck(List<ChangeOp> changes) {
        return TenantContext.with(new TenantInfo(1, 1, 1), () -> service.precheck(modelId, changes));
    }

    private void saveTwoFields() {
        Map<String, Object> pre = precheck(List.of(addAmount(), addStatus()));
        TenantContext.with(new TenantInfo(1, 1, 1), () ->
                service.saveSchema(modelId, List.of(addAmount(), addStatus()),
                        1, (String) pre.get("confirmToken"), null));
    }

    private static ChangeOp.AddField addAmount() {
        return new ChangeOp.AddField("amount", Map.of("label", "金额", "type", "number"));
    }

    private static ChangeOp.AddField addStatus() {
        return new ChangeOp.AddField("status", Map.of("label", "状态", "type", "enum"));
    }

    private BizException expectBiz(java.util.function.Supplier<Object> action) {
        return TenantContext.with(new TenantInfo(1, 1, 1), () -> {
            try {
                action.get();
                return null;
            } catch (BizException ex) {
                return ex;
            }
        });
    }

    /** void 动作包装（deleteModelConfirm 等无返回值方法）。 */
    private BizException expectBizVoid(Runnable action) {
        return expectBiz(() -> {
            action.run();
            return null;
        });
    }
}
