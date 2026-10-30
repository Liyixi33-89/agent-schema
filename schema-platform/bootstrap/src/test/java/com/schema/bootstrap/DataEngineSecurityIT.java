package com.schema.bootstrap;

import com.schema.data.application.DynamicQueryEngine;
import com.schema.metadata.application.MetadataCommandService;
import com.schema.metadata.domain.model.ChangeOp;
import com.schema.platform.common.tenant.PreviewContext;
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
 * M5 收口缺口场景测试（2026-10-30 审查后补齐）：
 * 字段级权限真实限制 / 部门范围（DEPT/DEPT_TREE 真实上下文与默认拒绝） /
 * 只读预览凭证写入拒绝 / 限页模型范围 / 写入校验链（类型/范围/枚举/必填清空） /
 * 历史键保留（DELETED 字段值不丢）/ 批量 upsert / 唯一性范围泄露 /
 * 聚合参数顺序（SELF+filter）/ 时间桶范围强制 / WEEK 桶边界。
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
class DataEngineSecurityIT {

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
        // 只清测试自造角色（it_ 前缀）——种子角色 seed_data_admin 是 userId=1 的 ALL 范围来源，
        // 删掉会连锁破坏其它测试类的管理员口径
        List<Long> testRoles = jdbc.queryForList(
                "SELECT id FROM sys_role WHERE code LIKE 'it_%'", Long.class);
        for (Long roleId : testRoles) {
            jdbc.update("DELETE FROM sys_role_permission WHERE role_id=?", roleId);
            jdbc.update("DELETE FROM sys_role_data_scope WHERE role_id=?", roleId);
            jdbc.update("DELETE FROM sys_user_role WHERE role_id=?", roleId);
        }
        jdbc.update("DELETE FROM sys_role WHERE code LIKE 'it_%'");
        jdbc.update("DELETE FROM sys_user WHERE account LIKE 'it_%'");
        jdbc.update("DELETE FROM sys_dept WHERE path LIKE '/3%' OR path LIKE '/4%'");
        // 种子角色自愈（历史测试库可能已被旧版 warmup 清掉——幂等重建 userId=1 的 ALL 范围）
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
        String modelKey = "sec_" + System.nanoTime();
        modelId = TenantContext.with(T1, () ->
                Long.parseLong((String) metadata.createModel(modelKey, "安全测试", null).get("id")));
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
                    new ChangeOp.AddField("amount", Map.of("label", "金额", "type", "number",
                            "validators", List.of(Map.of("type", "range", "min", 0, "max", 1000)))),
                    new ChangeOp.AddField("owner", Map.of("label", "归属", "type", "text", "required", true)),
                    new ChangeOp.AddField("salary", Map.of("label", "薪水", "type", "number")),
                    new ChangeOp.AddField("memo", Map.of("label", "备注", "type", "text")),
                    new ChangeOp.AddField("dept_id", Map.of("label", "部门", "type", "dept")),
                    new ChangeOp.AddField("created_day", Map.of("label", "日期", "type", "date")));
            Map<String, Object> pre = metadata.precheck(modelId, ops);
            metadata.saveSchema(modelId, ops, 1, (String) pre.get("confirmToken"), null);
            return null;
        });
    }

    private long insert(Map<String, Object> data, long createdBy) {
        long id = TenantContext.with(T1, () -> {
            Map<String, Object> resp = engine.create(modelId, data);
            return (Long) resp.get("id");
        });
        jdbc.update("UPDATE biz_model_" + modelId + " SET created_by=? WHERE id=?", createdBy, id);
        return id;
    }

    private Map<String, Object> record(String status, Object amount, String owner, Object day) {
        Map<String, Object> m = new LinkedHashMap<>();
        if (status != null) m.put("status", status);
        if (amount != null) m.put("amount", amount);
        if (owner != null) m.put("owner", owner);
        if (day != null) m.put("created_day", day);
        return m;
    }

    // ---------- 字段级权限（授权集语义） ----------

    @Test
    void fieldPermGrantsOnlyAuthorizedFields() {
        long id = insert(record("draft", 100, "u1", "2026-10-01"), 1);
        jdbc.update("UPDATE biz_model_" + modelId + " SET data = data || '{\"salary\": 500}'::jsonb WHERE id=?", id);

        // 用户 50 绑定角色：仅授权可见 status/owner，仅可编辑 status；行级 SELF（自建一行）
        long roleId = seedRole(50);
        jdbc.update("INSERT INTO sys_role_permission (role_id, resource_type, resource_id, action) "
                + "VALUES (?, 'FIELD', ?, 'visible:status'), (?, 'FIELD', ?, 'visible:owner'), "
                + "(?, 'FIELD', ?, 'editable:status')",
                roleId, modelId, roleId, modelId, roleId, modelId);
        jdbc.update("INSERT INTO sys_role_data_scope (role_id, model_id, scope_type) "
                + "VALUES (?, ?, 'ALL')", roleId, modelId);
        try {
            TenantInfo user50 = new TenantInfo(1, 1, 50);
            // 自建一行保证 ALL 范围内可见
            TenantContext.with(user50, () -> {
                engine.create(modelId, record("draft", 10, "u50", "2026-10-01"));
                return null;
            });
            Map<String, Object> detail = TenantContext.with(user50, () -> engine.getById(modelId, id));
            assertTrue(detail.containsKey("status"), "授权字段可见");
            assertTrue(detail.containsKey("owner"), "授权字段可见");
            assertFalse(detail.containsKey("salary"), "未授权字段物理剔除");
            assertFalse(detail.containsKey("amount"), "未授权字段物理剔除");

            // 不可编辑字段写入被静默忽略：改 salary 不得生效
            TenantContext.with(user50, () -> {
                Map<String, Object> patch = new LinkedHashMap<>();
                patch.put("salary", 999);
                patch.put("status", "approved");
                engine.update(modelId, id, patch);
                return null;
            });
            Map<String, Object> after = TenantContext.with(user50, () -> engine.getById(modelId, id));
            assertEquals("approved", after.get("status"), "可编辑字段生效");
            Object salary = jdbc.queryForObject(
                    "SELECT data->>'salary' FROM biz_model_" + modelId + " WHERE id=?", String.class, id);
            assertEquals("500", new java.math.BigDecimal(String.valueOf(salary)).stripTrailingZeros().toPlainString(),
                    "不可编辑字段提交被静默忽略（现值保留）");
        } finally {
            cleanupRole(roleId);
        }
    }

    @Test
    void fieldPermUnconfiguredModelAllVisible() {
        // 未配置 FIELD 行：全字段可见（不锁死未配置模型）
        long id = insert(record("draft", 100, "u1", "2026-10-01"), 1);
        long roleId = seedRole(60);
        jdbc.update("INSERT INTO sys_role_data_scope (role_id, model_id, scope_type) "
                + "VALUES (?, ?, 'ALL')", roleId, modelId);
        try {
            Map<String, Object> detail = TenantContext.with(new TenantInfo(1, 1, 60),
                    () -> engine.getById(modelId, id));
            assertTrue(detail.containsKey("amount"), "未配置字段权限的模型全字段可见");
        } finally {
            cleanupRole(roleId);
        }
    }

    // ---------- 部门范围 ----------

    @Test
    void deptScopeFiltersByRealDeptContext() {
        // 部门（path=/300/）：用户归属该部门；数据行 dept_id 决定可见性
        Long deptId = jdbc.queryForObject(
                "INSERT INTO sys_dept (tenant_id, path, name) VALUES (1, '/300/', '销售部') RETURNING id",
                Long.class);
        long deptUserId = seedUserWithDept("it_dept_scope_" + System.nanoTime(), deptId);
        try {
            insertDeptRow(String.valueOf(deptId), 11);     // 本部门行（可见）
            insertDeptRow("999999", 22);                    // 他部门行（不可见）

            long roleId = seedRole(deptUserId);
            jdbc.update("INSERT INTO sys_role_data_scope (role_id, model_id, scope_type) "
                    + "VALUES (?, ?, 'DEPT')", roleId, modelId);
            try {
                Map<String, Object> resp = TenantContext.with(new TenantInfo(1, 1, deptUserId), () ->
                        engine.query(new com.schema.data.domain.engine.SqlBuilder.QueryRequest(
                                modelId, null, List.of(), 1, 20, null, 0, false)));
                assertEquals(1L, ((Number) resp.get("total")).longValue(),
                        "DEPT 范围仅见本部门记录");
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> list = (List<Map<String, Object>>) resp.get("list");
                assertEquals(String.valueOf(deptId), list.get(0).get("dept_id"));
            } finally {
                cleanupRole(roleId);
            }

            // 无部门用户 + DEPT 范围 → 默认拒绝（不退化放宽）
            long noDeptUserId = seedUserWithDept("it_nodept_" + System.nanoTime(), null);
            long roleIdNoDept = seedRole(noDeptUserId);
            jdbc.update("INSERT INTO sys_role_data_scope (role_id, model_id, scope_type) "
                    + "VALUES (?, ?, 'DEPT')", roleIdNoDept, modelId);
            try {
                Map<String, Object> resp = TenantContext.with(
                        new TenantInfo(1, 1, noDeptUserId), () ->
                                engine.query(new com.schema.data.domain.engine.SqlBuilder.QueryRequest(
                                        modelId, null, List.of(), 1, 20, null, 0, false)));
                assertEquals(0L, ((Number) resp.get("total")).longValue(),
                        "无部门上下文 DEPT 范围默认拒绝");
            } finally {
                cleanupRole(roleIdNoDept);
            }
        } finally {
            jdbc.update("DELETE FROM sys_dept WHERE id=?", deptId);
        }
    }

    @Test
    void deptTreeScopeIncludesSubtreeWithTenantCondition() {
        // 部门树：/400/ 父部门 + /400/401/ 子部门；用户归属父部门
        Long parentDept = jdbc.queryForObject(
                "INSERT INTO sys_dept (tenant_id, path, name) VALUES (1, '/400/', '华东区') RETURNING id",
                Long.class);
        Long childDept = jdbc.queryForObject(
                "INSERT INTO sys_dept (tenant_id, parent_id, path, name) "
                        + "VALUES (1, ?, '/400/401/', '上海') RETURNING id", Long.class, parentDept);
        long treeUserId = seedUserWithDept("it_dept_tree_" + System.nanoTime(), parentDept);
        try {
            insertDeptRow(String.valueOf(parentDept), 11);        // 父部门行
            insertDeptRow(String.valueOf(childDept), 22);         // 子部门行——DEPT_TREE 应可见
            insertDeptRow("999999", 33);                          // 树外行

            long roleId = seedRole(treeUserId);
            jdbc.update("INSERT INTO sys_role_data_scope (role_id, model_id, scope_type) "
                    + "VALUES (?, ?, 'DEPT_TREE')", roleId, modelId);
            try {
                Map<String, Object> resp = TenantContext.with(new TenantInfo(1, 1, treeUserId), () ->
                        engine.query(new com.schema.data.domain.engine.SqlBuilder.QueryRequest(
                                modelId, null, List.of(), 1, 20, null, 0, false)));
                assertEquals(2L, ((Number) resp.get("total")).longValue(),
                        "DEPT_TREE 含子部门记录（树外 999999 不可见）");
            } finally {
                cleanupRole(roleId);
            }
        } finally {
            jdbc.update("DELETE FROM sys_dept WHERE id IN (?, ?)", parentDept, childDept);
        }
    }

    // ---------- 预览数据面 ----------

    @Test
    void previewReadOnlyWriteDenied() {
        insert(record("draft", 100, "u1", "2026-10-01"), 1);
        // 只读预览会话：写操作拒绝
        PreviewContext.bind(true, null, false);
        try {
            BizException e = assertThrows(BizException.class, () ->
                    TenantContext.with(T1, () -> engine.create(modelId, record("draft", 1, "pv", null))));
            assertEquals("PREVIEW_WRITE_DENIED", e.code(), "只读预览写入必须拒绝");
        } finally {
            PreviewContext.clear();
        }
        // allowRealWrite=true：放行（发起人显式声明）
        PreviewContext.bind(true, null, true);
        try {
            TenantContext.with(T1, () -> engine.create(modelId, record("draft", 1, "pv", null)));
        } finally {
            PreviewContext.clear();
        }
    }

    @Test
    void previewPageBoundModelScope() {
        // 限页会话访问非绑定模型 → PREVIEW_SCOPE_DENIED
        PreviewContext.bind(true, 999999L, false);
        try {
            BizException e = assertThrows(BizException.class, () ->
                    TenantContext.with(T1, () -> engine.query(
                            new com.schema.data.domain.engine.SqlBuilder.QueryRequest(
                                    modelId, null, List.of(), 1, 20, null, 0, false))));
            assertEquals("PREVIEW_SCOPE_DENIED", e.code(), "限页预览访问页外模型必须拒绝");
        } finally {
            PreviewContext.clear();
        }
    }

    // ---------- 写入校验链 ----------

    @Test
    void writeValidationChain() {
        // 类型校验：amount 传非数值
        BizException e1 = TenantContext.with(T1, () -> {
            try {
                engine.create(modelId, record("draft", "abc", "u1", null));
                return null;
            } catch (BizException ex) {
                return ex;
            }
        });
        assertNotNull(e1);
        assertEquals("VALIDATION_FAILED", e1.code());

        // 范围校验：amount=5000 越界（validators range 0-1000）
        BizException e2 = TenantContext.with(T1, () -> {
            try {
                engine.create(modelId, record("draft", 5000, "u1", null));
                return null;
            } catch (BizException ex) {
                return ex;
            }
        });
        assertNotNull(e2, "range 校验必须拦截");

        // 枚举校验：status 越界
        BizException e3 = TenantContext.with(T1, () -> {
            try {
                engine.create(modelId, record("unknown_status", 100, "u1", null));
                return null;
            } catch (BizException ex) {
                return ex;
            }
        });
        assertNotNull(e3, "枚举值域校验必须拦截");

        // 必填校验（创建）：owner 缺失
        BizException e4 = TenantContext.with(T1, () -> {
            try {
                engine.create(modelId, record("draft", 100, null, null));
                return null;
            } catch (BizException ex) {
                return ex;
            }
        });
        assertEquals("VALIDATION_FAILED", e4.code());

        // 日期校验：created_day 非日期形态
        BizException e5 = TenantContext.with(T1, () -> {
            try {
                engine.create(modelId, record("draft", 100, "u1", "not-a-date"));
                return null;
            } catch (BizException ex) {
                return ex;
            }
        });
        assertNotNull(e5, "日期类型校验必须拦截");
    }

    @Test
    void updateRequiredCannotBeCleared() {
        long id = insert(record("draft", 100, "u1", "2026-10-01"), 1);
        // 显式传 null 清空必填 owner → 拒绝
        Map<String, Object> patch = record("draft", 100, null, null);
        patch.put("owner", null);
        BizException e = TenantContext.with(T1, () -> {
            try {
                engine.update(modelId, id, patch);
                return null;
            } catch (BizException ex) {
                return ex;
            }
        });
        assertNotNull(e, "清空必填字段必须抛异常");
        assertEquals("VALIDATION_FAILED", e.code(), "更新清空必填字段必须拒绝");
    }

    // ---------- 历史键保留 ----------

    @Test
    void deletedFieldHistoryKeyPreservedOnUpdate() {
        long id = insert(record("draft", 100, "u1", "2026-10-01"), 1);
        jdbc.update("UPDATE biz_model_" + modelId
                + " SET data = data || '{\"legacy_field\": \"OLD_VALUE\"}'::jsonb WHERE id=?", id);
        // 删除字段后更新：legacy 键必须保留
        TenantContext.with(T1, () -> {
            List<ChangeOp> del = List.of(
                    new ChangeOp.DeleteField("salary"),
                    new ChangeOp.DeleteField("memo"));
            Map<String, Object> pre = metadata.precheck(modelId, del);
            metadata.saveSchema(modelId, del, currentVersion(), (String) pre.get("confirmToken"), null);
            engine.update(modelId, id, record("approved", 200, "u1", null));
            return null;
        });
        String raw = jdbc.queryForObject(
                "SELECT data->>'legacy_field' FROM biz_model_" + modelId + " WHERE id=?",
                String.class, id);
        assertEquals("OLD_VALUE", raw, "DELETED 字段历史键值不得因更新丢失");
        Map<String, Object> detail = TenantContext.with(T1, () -> engine.getById(modelId, id));
        assertFalse(detail.containsKey("legacy_field"), "读面不透出 DELETED 键（展示层剔除）");
    }

    // ---------- 批量 upsert ----------

    @Test
    void batchUpsertInsertAndUpdate() {
        // owner 设唯一约束后做批量键
        TenantContext.with(T1, () -> {
            List<ChangeOp> ops = List.of(new ChangeOp.ModifyField("owner",
                    Map.of("uniqueFlag", true)));
            Map<String, Object> pre = metadata.precheck(modelId, ops);
            metadata.saveSchema(modelId, ops, currentVersion(), (String) pre.get("confirmToken"), null);
            return null;
        });
        Map<String, Object> r1 = record("draft", 100, "batch_a", null);
        Map<String, Object> r2 = record("draft", 200, "batch_b", null);
        Map<String, Object> resp = TenantContext.with(T1, () ->
                engine.batchUpsert(modelId, List.of(r1, r2), "owner"));
        assertEquals(2, ((Number) resp.get("inserted")).intValue());

        // 同键再批量：全走更新分支
        Map<String, Object> r1upd = record("approved", 300, "batch_a", null);
        Map<String, Object> resp2 = TenantContext.with(T1, () ->
                engine.batchUpsert(modelId, List.of(r1upd), "owner"));
        assertEquals(1, ((Number) resp2.get("updated")).intValue(), "同键重放走更新");
        assertEquals(0, ((Number) resp2.get("inserted")).intValue());

        // 批量上限：501 行拒绝
        List<Map<String, Object>> tooMany = new java.util.ArrayList<>();
        for (int i = 0; i < 501; i++) {
            tooMany.add(record("draft", i, "bulk_" + i, null));
        }
        BizException e = assertThrows(BizException.class, () -> TenantContext.with(T1, () ->
                engine.batchUpsert(modelId, tooMany, "owner")));
        assertEquals("BATCH_TOO_LARGE", e.code());
    }

    // ---------- 唯一性范围泄露 ----------

    @Test
    void uniqueCheckDoesNotLeakOutOfScope() {
        // 行 owner=secret_owner createdBy=999（无范围用户视角外）
        insert(record("draft", 100, "secret_owner", null), 999);
        // userId=80 无任何范围（默认拒绝）：唯一校验不得泄露权限外数据的存在性
        Map<String, Object> resp = TenantContext.with(new TenantInfo(1, 1, 80), () ->
                engine.uniqueCheck(modelId, "owner", "secret_owner", null));
        // 权限外数据不可见 → unique=true（不给冲突线索）
        assertEquals(Boolean.TRUE, resp.get("unique"), "权限外数据的唯一冲突不得泄露");
    }

    // ---------- 聚合参数顺序（SELF + filter 并存） ----------

    @Test
    void aggregateSelfScopeWithFilterParamsAligned() {
        // SELF 用户自建一行 amount=77，status=draft；他建一行 amount=999 status=draft
        TenantContext.with(new TenantInfo(1, 1, 71), () -> {
            engine.create(modelId, record("draft", 77, "u71", null));
            return null;
        });
        insert(record("draft", 999, "stranger", null), 22);
        long roleId = seedRole(71);
        jdbc.update("INSERT INTO sys_role_data_scope (role_id, model_id, scope_type) "
                + "VALUES (?, ?, 'SELF')", roleId, modelId);
        try {
            // SELF + status 过滤并存：参数若错位会把 userId 当 status 匹配 → 0 行或异常
            Map<String, Object> filter = Map.of("field", "status", "op", "eq", "value", "draft");
            Map<String, Object> resp = TenantContext.with(new TenantInfo(1, 1, 71), () ->
                    engine.aggregate(new com.schema.data.domain.engine.AggregateBuilder.AggRequest(
                            modelId, filter,
                            List.of(new com.schema.data.domain.engine.AggregateBuilder.AggMeasure(
                                    "amount", "SUM")),
                            null, null, null, null)));
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> rows = (List<Map<String, Object>>) resp.get("rows");
            Object sum = ((List<Map<String, Object>>) rows.get(0).get("values")).get(0).get("value");
            assertEquals(77, ((Number) sum).intValue(), "SELF+filter 参数对齐：SUM 恰为自己的 77");
        } finally {
            cleanupRole(roleId);
        }
    }

    // ---------- 时间桶 ----------

    @Test
    void timeBucketRequiresRangeAndWeekBoundary() {
        // 2026-10-05 是周一（ISO 周起点）；10-11 是同周周日；10-12 才进下一周
        insert(record("draft", 10, "u1", "2026-10-05"), 1);   // 周一
        insert(record("draft", 20, "u2", "2026-10-11"), 1);   // 同周周日
        insert(record("draft", 30, "u3", "2026-10-12"), 1);   // 下周一

        // 无范围时间桶 → 拒绝（无限桶防护）
        BizException e = TenantContext.with(T1, () -> {
            try {
                engine.aggregate(new com.schema.data.domain.engine.AggregateBuilder.AggRequest(
                        modelId, null,
                        List.of(new com.schema.data.domain.engine.AggregateBuilder.AggMeasure(
                                "__count", "COUNT")),
                        null, null, "created_day", "WEEK"));
                return null;
            } catch (BizException ex) {
                return ex;
            }
        });
        assertEquals("FILTER_OPERATOR_INVALID", e.code(), "无范围时间桶必须拒绝");

        // 带范围 WEEK 桶：前三行两周——10-05 当周（2 行）+ 10-12 当周（1 行）
        Map<String, Object> filter = Map.of(
                "field", "created_day", "op", "gte", "value", "2026-10-01");
        Map<String, Object> resp = TenantContext.with(T1, () ->
                engine.aggregate(new com.schema.data.domain.engine.AggregateBuilder.AggRequest(
                        modelId, filter,
                        List.of(new com.schema.data.domain.engine.AggregateBuilder.AggMeasure(
                                "__count", "COUNT")),
                        null, null, "created_day", "WEEK")));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> rows = (List<Map<String, Object>>) resp.get("rows");
        assertEquals(2, rows.size(), "WEEK 桶按 ISO 周一起点分两周");
    }

    // ---------- 工具 ----------

    private int currentVersion() {
        return jdbc.queryForObject("SELECT current_version FROM meta_model WHERE id=?",
                Integer.class, modelId);
    }

    private long seedRole(long userId) {
        Long roleId = jdbc.queryForObject(
                "INSERT INTO sys_role (tenant_id, code, name, role_type) "
                        + "VALUES (1, ?, ?, 'TENANT') RETURNING id",
                Long.class, "it_sec_" + System.nanoTime(), "安全测试角色");
        jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", userId, roleId);
        return roleId;
    }

    private void cleanupRole(long roleId) {
        jdbc.update("DELETE FROM sys_role_permission WHERE role_id=?", roleId);
        jdbc.update("DELETE FROM sys_role_data_scope WHERE role_id=?", roleId);
        jdbc.update("DELETE FROM sys_user_role WHERE role_id=?", roleId);
        jdbc.update("DELETE FROM sys_role WHERE id=?", roleId);
    }

    private long seedUserWithDept(String account, Long deptId) {
        // 测试专用账号插入（无密码——认证面不走此处）；返回真实自增 ID
        return jdbc.queryForObject(
                "INSERT INTO sys_user (tenant_id, account, name, status, dept_id) "
                        + "VALUES (1, ?, ?, 'ACTIVE', ?) RETURNING id",
                Long.class, account, account, deptId);
    }

    private void insertDeptRow(String deptKey, long createdBy) {
        Map<String, Object> data = record("draft", 10, "dept-row", null);
        data.put("dept_id", deptKey);
        long id = TenantContext.with(T1, () -> {
            Map<String, Object> resp = engine.create(modelId, data);
            return (Long) resp.get("id");
        });
        jdbc.update("UPDATE biz_model_" + modelId + " SET created_by=? WHERE id=?", createdBy, id);
    }
}
