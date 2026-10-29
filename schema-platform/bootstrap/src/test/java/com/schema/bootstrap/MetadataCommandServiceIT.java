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
}
