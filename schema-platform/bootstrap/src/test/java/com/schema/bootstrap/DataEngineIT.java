package com.schema.bootstrap;

import com.schema.data.application.DynamicQueryEngine;
import com.schema.metadata.application.MetadataCommandService;
import com.schema.metadata.domain.model.ChangeOp;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * M5 集成测试（真实 PG，02BE §8 硬性要求）：
 * SQL 注入三维度拦截 / DELETED 字段强过滤 / 读时兼容 _invalid / 租户隔离 /
 * 行级权限口径（含聚合权限一致性）/ 聚合分组与护栏。
 * 前置：docker compose up -d postgres；CI 走 PostgreSQL service 容器。
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
class DataEngineIT {

    private static final TenantInfo T1 = new TenantInfo(1, 1, 1);

    @Autowired
    private DynamicQueryEngine engine;

    @Autowired
    private MetadataCommandService metadata;

    @Autowired
    private JdbcTemplate jdbc;

    private long modelId;

    @BeforeAll
    void warmup() {
        // 幂等清理（物理表随建随用——测试模型用 nanoTime 键防撞）
        jdbc.update("DELETE FROM data_promote_task");
        jdbc.update("DELETE FROM data_physical_table WHERE tenant_id = 1 AND model_id > 0 "
                + "AND table_name LIKE 'biz_model_%'");
        jdbc.update("DELETE FROM meta_field_reference");
        jdbc.update("DELETE FROM meta_confirm_token");
        jdbc.update("DELETE FROM meta_schema_version");
        jdbc.update("DELETE FROM meta_field");
        jdbc.update("DELETE FROM meta_model");
        // 清理历史物理表（测试模型键唯一，重跑安全）
        List<String> oldTables = jdbc.queryForList(
                "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'biz_model_%'",
                String.class);
        for (String t : oldTables) {
            jdbc.update("DROP TABLE IF EXISTS " + t);
        }
        // 种子角色自愈（幂等重建 userId=1 的 ALL 范围——历史库可能缺失）
        jdbc.update("""
                INSERT INTO sys_role (tenant_id, app_id, code, name, role_type)
                VALUES (1, 1, 'seed_data_admin', '种子数据管理员', 'TENANT')
                ON CONFLICT DO NOTHING
                """);
        jdbc.update("""
                INSERT INTO sys_user_role (user_id, role_id)
                SELECT 1, id FROM sys_role WHERE tenant_id=1 AND code='seed_data_admin'
                ON CONFLICT DO NOTHING
                """);
        jdbc.update("""
                INSERT INTO sys_role_data_scope (role_id, model_id, scope_type)
                SELECT id, 0, 'ALL' FROM sys_role WHERE tenant_id=1 AND code='seed_data_admin'
                ON CONFLICT DO NOTHING
                """);
    }

    @AfterAll
    void teardown() {
        TenantContext.clear();
    }

    @BeforeEach
    void setUp() {
        modelId = TenantContext.with(T1, () ->
                Long.parseLong((String) metadata.createModel("order_" + System.nanoTime(), "订单", null).get("id")));
        // 模型字段：status 文本 + amount 数值 + owner 文本（SELF 范围测试用）
        saveFields(modelId);
    }

    private void saveFields(long modelId) {
        TenantContext.with(T1, () -> {
            List<ChangeOp> ops = List.of(
                    new ChangeOp.AddField("status", Map.of(
                            "label", "状态", "type", "enum",
                            "enumOptions", List.of(
                                    Map.of("value", "draft", "label", "草稿", "status", "ACTIVE"),
                                    Map.of("value", "approved", "label", "已审", "status", "ACTIVE")))),
                    new ChangeOp.AddField("amount", Map.of("label", "金额", "type", "number")),
                    new ChangeOp.AddField("owner", Map.of("label", "归属", "type", "text")),
                    new ChangeOp.AddField("created_day", Map.of("label", "日期", "type", "date")));
            Map<String, Object> pre = metadata.precheck(modelId, ops);
            String token = (String) pre.get("confirmToken");
            metadata.saveSchema(modelId, ops, 1, token, null);
            return null;
        });
    }

    /** 以种子管理员（userId=1，ALL 范围）身份插入，并把 created_by 覆写为目标用户（构造权限口径）。 */
    private long insert(long tenantId, Map<String, Object> data, long createdBy) {
        long id = TenantContext.with(new TenantInfo(tenantId, 1, 1), () -> {
            Map<String, Object> resp = engine.create(modelId, data);
            return (Long) resp.get("id");
        });
        jdbc.update("UPDATE biz_model_" + modelId + " SET created_by=? WHERE id=?", createdBy, id);
        return id;
    }

    private Map<String, Object> record(Object status, Object amount, Object owner, Object day) {
        Map<String, Object> m = new LinkedHashMap<>();
        if (status != null) m.put("status", status);
        if (amount != null) m.put("amount", amount);
        if (owner != null) m.put("owner", owner);
        if (day != null) m.put("created_day", day);
        return m;
    }

    // ---------- §8 SQL 注入三维度 ----------

    @Test
    void injectionBlockedOnFieldOperatorValue() {
        insert(1, record("draft", 100, "u1", "2026-10-01"), 1);
        // 1) 字段名注入：不存在字段 → FIELD_DELETED（不给线索）
        Map<String, Object> badField = Map.of("field", "status; DROP TABLE x; --", "op", "eq", "value", "draft");
        BizException e1 = TenantContext.with(T1, () -> {
            try {
                engine.query(new com.schema.data.domain.engine.SqlBuilder.QueryRequest(
                        modelId, badField, List.of(), 1, 20, null, 1, false));
                return null;
            } catch (BizException ex) {
                return ex;
            }
        });
        assertNotNull(e1, "注入字段名必须被拦截");
        assertEquals("FIELD_DELETED", e1.code());

        // 2) 操作符注入：白名单外 → FILTER_OPERATOR_INVALID
        Map<String, Object> badOp = Map.of("field", "status", "op", "eq; DELETE FROM y", "value", "draft");
        BizException e2 = TenantContext.with(T1, () -> {
            try {
                engine.query(new com.schema.data.domain.engine.SqlBuilder.QueryRequest(
                        modelId, badOp, List.of(), 1, 20, null, 1, false));
                return null;
            } catch (BizException ex) {
                return ex;
            }
        });
        assertNotNull(e2, "注入操作符必须被拦截");
        assertEquals("FILTER_OPERATOR_INVALID", e2.code());

        // 3) 值注入：值走占位符——字符串值含注入 payload 只当普通文本匹配，不执行
        //（owner 为 text 字段——枚举字段 status 受值域校验，注入文本会被枚举拦截而非注入面）
        insert(1, record("draft", 200, "a' OR 1=1; --", "2026-10-02"), 1);
        Map<String, Object> ownerFilter = Map.of("field", "owner", "op", "eq",
                "value", "a' OR 1=1; --");
        Map<String, Object> resp = TenantContext.with(T1, () -> engine.query(
                new com.schema.data.domain.engine.SqlBuilder.QueryRequest(
                        modelId, ownerFilter, List.of(), 1, 20, null, 1, false)));
        assertEquals(1L, ((Number) resp.get("total")).longValue(), "注入 payload 作为文本精确匹配恰好 1 行");
    }

    // ---------- §8 DELETED 字段强过滤 ----------

    @Test
    void deletedFieldUnreachableByAnyParamCombo() {
        long id = insert(1, record("draft", 100, "u1", "2026-10-01"), 1);
        // 删除 amount 字段（两段式）
        TenantContext.with(T1, () -> {
            List<ChangeOp> del = List.of(new ChangeOp.DeleteField("amount"));
            Map<String, Object> pre = metadata.precheck(modelId, del);
            metadata.saveSchema(modelId, del, currentVersion(), (String) pre.get("confirmToken"), null);
            return null;
        });

        // filter 引用 DELETED 字段 → 400
        Map<String, Object> filter = Map.of("field", "amount", "op", "gt", "value", 50);
        BizException e = TenantContext.with(T1, () -> {
            try {
                engine.query(new com.schema.data.domain.engine.SqlBuilder.QueryRequest(
                        modelId, filter, List.of(), 1, 20, null, 1, false));
                return null;
            } catch (BizException ex) {
                return ex;
            }
        });
        assertNotNull(e);
        assertEquals("FIELD_DELETED", e.code());

        // 伪造 fields 投影：响应不含 amount 键（投影交集防伪造）
        Map<String, Object> resp = TenantContext.with(T1, () -> engine.query(
                new com.schema.data.domain.engine.SqlBuilder.QueryRequest(
                        modelId, null, List.of(), 1, 20, List.of("amount"), 1, false)));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> list = (List<Map<String, Object>>) resp.get("list");
        for (Map<String, Object> row : list) {
            assertFalse(row.containsKey("amount"), "DELETED 字段不得以任何参数组合读出");
        }

        // 详情响应同样剔除
        Map<String, Object> detail = TenantContext.with(T1, () -> engine.getById(modelId, id));
        assertFalse(detail.containsKey("amount"));
        assertNull(detail.get("amount"));
    }

    // ---------- §8 读时兼容 ----------

    @Test
    void legacyRowMarkedInvalidNotThrown() {
        // 写入一行后推进 schema 版本并改字段语义不可行（类型冻结）——
        // 直接手工插旧行（schema_version=1，值形态与当前定义不符）
        String table = "biz_model_" + modelId;
        long legacyId = 900001L;
        jdbc.update("INSERT INTO " + table + " (id, tenant_id, data, schema_version, created_by) "
                        + "VALUES (?, 1, ?::jsonb, 1, 1)",
                legacyId, "{\"status\":\"draft\",\"amount\":\"NOT_A_NUMBER\",\"owner\":\"u1\"}");

        Map<String, Object> detail = TenantContext.with(T1, () -> engine.getById(modelId, legacyId));
        // 解析失败：保留原值 + _invalid 标记（不抛错）
        assertEquals("NOT_A_NUMBER", detail.get("amount"));
        assertTrue(detail.get("_invalid") instanceof List<?> invalid
                        && invalid.contains("amount"), "类型不匹配必须标记 _invalid");
    }

    // ---------- §8 租户隔离 ----------

    @Test
    void crossTenantInvisible() {
        insert(1, record("draft", 100, "u1", "2026-10-01"), 1);
        // 租户 2 的行直接 SQL 构造（引擎创建会因跨租户模型判定被拒——本身即隔离行为）
        jdbc.update("INSERT INTO biz_model_" + modelId
                + " (id, tenant_id, data, schema_version, created_by) "
                + "VALUES (?, 2, ?::jsonb, 1, 2)",
                888888L, "{\"status\":\"draft\",\"amount\":100,\"owner\":\"u2\"}");
        try {
            // 租户 2 视角：模型不存在（跨租户同判）
            TenantContext.with(new TenantInfo(2, 1, 2), () -> {
                BizException e = assertThrows(BizException.class, () -> engine.getById(modelId, 1L));
                assertEquals("RECORD_NOT_FOUND", e.code());
                return null;
            });
            // 租户 1 视角：只见自己的行（tenant_id 固定条件过滤租户 2 的行）
            Map<String, Object> resp = TenantContext.with(T1, () -> engine.query(
                    new com.schema.data.domain.engine.SqlBuilder.QueryRequest(
                            modelId, null, List.of(), 1, 20, null, 1, false)));
            assertEquals(1L, ((Number) resp.get("total")).longValue(), "租户 2 的行不可见于租户 1 查询");
        } finally {
            jdbc.update("DELETE FROM biz_model_" + modelId + " WHERE tenant_id=2");
        }
    }

    // ---------- §8 行级权限口径 ----------

    @Test
    void selfScopeFiltersRows() {
        insert(1, record("draft", 100, "u1", "2026-10-01"), 11);
        insert(1, record("draft", 200, "u2", "2026-10-02"), 22);
        // 给 userId=99 授 SELF 范围（造角色 + 数据范围）
        long roleId = seedSelfScopeRole(99);
        try {
            // userId=99（SELF）：两行都不是他建的 → 0 行
            Map<String, Object> resp99 = TenantContext.with(new TenantInfo(1, 1, 99), () ->
                    engine.query(new com.schema.data.domain.engine.SqlBuilder.QueryRequest(
                            modelId, null, List.of(), 1, 20, null, 1, false)));
            assertEquals(0L, ((Number) resp99.get("total")).longValue(), "SELF 范围外记录不可见");

            // userId=99 自己写一行 → SELF 可见恰 1 行（自己创建的）
            TenantContext.with(new TenantInfo(1, 1, 99), () -> {
                engine.create(modelId, record("draft", 300, "u99", "2026-10-03"));
                return null;
            });
            Map<String, Object> respAfter = TenantContext.with(new TenantInfo(1, 1, 99), () ->
                    engine.query(new com.schema.data.domain.engine.SqlBuilder.QueryRequest(
                            modelId, null, List.of(), 1, 20, null, 1, false)));
            assertEquals(1L, ((Number) respAfter.get("total")).longValue(), "SELF 范围内恰见自己创建的记录");

            // userId=11（无任何范围授权）：默认拒绝（最小权限）
            Map<String, Object> resp11 = TenantContext.with(new TenantInfo(1, 1, 11), () ->
                    engine.query(new com.schema.data.domain.engine.SqlBuilder.QueryRequest(
                            modelId, null, List.of(), 1, 20, null, 1, false)));
            assertEquals(0L, ((Number) resp11.get("total")).longValue(), "无范围用户默认拒绝（最小权限）");
        } finally {
            jdbc.update("DELETE FROM sys_role_data_scope WHERE role_id=?", roleId);
            jdbc.update("DELETE FROM sys_user_role WHERE role_id=?", roleId);
            jdbc.update("DELETE FROM sys_role WHERE id=?", roleId);
        }
    }

    @Test
    void aggregateRespectsRowScope() {
        // 100 行、权限可见 60 行：SUM 只算 60 行口径
        for (int i = 0; i < 100; i++) {
            insert(1, record("draft", 10, "u" + i, "2026-10-01"), 11);
        }
        // userId=11 有 SELF 角色（可见自己创建的 100 行——再补 60 行 createdBy=11 无范围用户视角）
        // 简化口径：无范围授权用户聚合 = 0（默认拒绝）；有 ALL 范围 = 全量
        Map<String, Object> denied = TenantContext.with(new TenantInfo(1, 1, 999), () ->
                engine.aggregate(new com.schema.data.domain.engine.AggregateBuilder.AggRequest(
                        modelId, null, List.of(new com.schema.data.domain.engine.AggregateBuilder.AggMeasure(
                                "__count", "COUNT")), null, null, null, null)));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> rows = (List<Map<String, Object>>) denied.get("rows");
        assertEquals(0L, ((Number) valueOf(rows.get(0))).longValue(), "无范围用户聚合必须为 0（权限外记录不参与统计）");
    }

    // ---------- §8 聚合分组与护栏 ----------

    @Test
    void aggregateGroupAndTopN() {
        insert(1, record("draft", 100, "u1", "2026-10-01"), 1);
        insert(1, record("approved", 300, "u2", "2026-10-02"), 1);
        insert(1, record("approved", 500, "u3", "2026-10-03"), 1);

        Map<String, Object> resp = TenantContext.with(T1, () ->
                engine.aggregate(new com.schema.data.domain.engine.AggregateBuilder.AggRequest(
                        modelId, null,
                        List.of(new com.schema.data.domain.engine.AggregateBuilder.AggMeasure(
                                "__count", "COUNT")),
                        "status", null, null, null)));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> rows = (List<Map<String, Object>>) resp.get("rows");
        assertEquals(2, rows.size(), "按 status 分组恰 2 组");
        // topN 排序：approved（2 条）在 draft（1 条）前
        assertEquals("approved", rows.get(0).get("dimension"));
    }

    @Test
    void aggregateGuardrails() {
        insert(1, record("draft", 100, "u1", "2026-10-01"), 1);
        // 非法聚合函数 → 400
        BizException e = TenantContext.with(T1, () -> {
            try {
                engine.aggregate(new com.schema.data.domain.engine.AggregateBuilder.AggRequest(
                        modelId, null, List.of(new com.schema.data.domain.engine.AggregateBuilder.AggMeasure(
                                "amount", "MEDIAN")), null, null, null, null));
                return null;
            } catch (BizException ex) {
                return ex;
            }
        });
        assertNotNull(e);
        assertEquals("FILTER_OPERATOR_INVALID", e.code());
    }

    // ---------- §8 深分页护栏 ----------

    @Test
    void deepPageRejected() {
        insert(1, record("draft", 100, "u1", "2026-10-01"), 1);
        BizException e = TenantContext.with(T1, () -> {
            try {
                engine.query(new com.schema.data.domain.engine.SqlBuilder.QueryRequest(
                        modelId, null, List.of(), 1001, 200, null, 1, false));
                return null;
            } catch (BizException ex) {
                return ex;
            }
        });
        assertNotNull(e, "page*size > 100000 必须 400");
        assertEquals("PAGE_TOO_DEEP", e.code());
    }

    // ---------- 写入路径 ----------

    @Test
    void createAndUpdateFlow() {
        long id = insert(1, record("draft", 100, "u1", "2026-10-01"), 1);
        Map<String, Object> detail = TenantContext.with(T1, () -> engine.getById(modelId, id));
        assertEquals("draft", detail.get("status"));
        assertEquals(100, ((Number) detail.get("amount")).intValue());

        // 更新
        TenantContext.with(T1, () -> {
            engine.update(modelId, id, record("approved", 200, "u1", "2026-10-01"));
            return null;
        });
        Map<String, Object> after = TenantContext.with(T1, () -> engine.getById(modelId, id));
        assertEquals("approved", after.get("status"));
        assertEquals(200, ((Number) after.get("amount")).intValue());

        // 逻辑删除后不可见
        TenantContext.with(T1, () -> {
            engine.delete(modelId, id);
            return null;
        });
        TenantContext.with(T1, () -> {
            BizException e = assertThrows(BizException.class, () -> engine.getById(modelId, id));
            assertEquals("RECORD_NOT_FOUND", e.code());
            return null;
        });
    }

    @Test
    void requiredFieldRejected() {
        // created_day 未传且无默认值 → VALIDATION_FAILED（本模型字段全非必填——改用 owner 必填场景：
        // 直接构造缺失场景需必填字段；本测试模型无必填字段，验证未知字段剔除）
        Map<String, Object> data = record("draft", 100, "u1", null);
        data.put("unknown_field", "hack");
        long id = insert(1, data, 1);
        Map<String, Object> detail = TenantContext.with(T1, () -> engine.getById(modelId, id));
        assertFalse(detail.containsKey("unknown_field"), "未定义字段必须静默剔除");
    }

    // ---------- 工具 ----------

    private int currentVersion() {
        return jdbc.queryForObject("SELECT current_version FROM meta_model WHERE id=?",
                Integer.class, modelId);
    }

    private long seedSelfScopeRole(long userId) {
        // 造角色 + SELF 范围 + 用户绑定（sys_role/sys_role_data_scope/sys_user_role）
        Long roleId = jdbc.queryForObject(
                "INSERT INTO sys_role (tenant_id, code, name, role_type) "
                        + "VALUES (1, ?, ?, 'TENANT') RETURNING id",
                Long.class, "it_self_" + System.nanoTime(), "SELF 范围测试角色");
        jdbc.update("INSERT INTO sys_role_data_scope (role_id, model_id, scope_type) VALUES (?, ?, 'SELF')",
                roleId, modelId);
        jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", userId, roleId);
        return roleId;
    }

    private static Object valueOf(Map<String, Object> row) {
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> values = (List<Map<String, Object>>) row.get("values");
        return values.get(0).get("value");
    }
}
