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

import static org.junit.jupiter.api.Assertions.*;

/**
 * 写入链路三项收口 IT（2026-10-30）：
 * 1. computed PERSISTED 重算（用户传入值被表达式覆盖——计算字段不可伪造）；
 * 2. user/dept 引用存在性校验（跨租户/不存在引用拒绝写入）；
 * 3. visibleFieldViews 字段元数据（字段级权限过滤——未授权字段不出现在装载面）。
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
class WriteConstraintsIT {

    private static final TenantInfo T1 = new TenantInfo(1, 1, 1);
    /** 租户 2 的管理员（跨租户引用测试用——同账号体系但 tenant_id=2）。 */
    private static final TenantInfo T2 = new TenantInfo(2, 1, 1);

    @Autowired
    private DynamicQueryEngine engine;

    @Autowired
    private MetadataCommandService metadata;

    @Autowired
    private JdbcTemplate jdbc;

    private long modelId;

    @BeforeAll
    void warmup() {
        // 与 DataEngineIT 同清理口径（独立文件防相互干扰——本类模型键带 writec_ 前缀）
        List<String> oldTables = jdbc.queryForList(
                "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'biz_model_%'",
                String.class);
        for (String t : oldTables) {
            jdbc.update("DROP TABLE IF EXISTS " + t);
        }
        jdbc.update("DELETE FROM data_physical_table WHERE table_name LIKE 'biz_model_%'");
        jdbc.update("DELETE FROM meta_field_reference");
        jdbc.update("DELETE FROM meta_confirm_token");
        jdbc.update("DELETE FROM meta_schema_version");
        jdbc.update("DELETE FROM meta_field");
        jdbc.update("DELETE FROM meta_model WHERE model_key LIKE 'writec_%'");
        // 种子角色自愈（DataEngineIT 同款——userId=1 无范围则记录不可见）
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
                Long.parseLong((String) metadata.createModel(
                        "writec_" + System.nanoTime(), "约束测试", null).get("id")));
        TenantContext.with(T1, () -> {
            List<ChangeOp> ops = List.of(
                    new ChangeOp.AddField("qty", Map.of("label", "数量", "type", "number")),
                    new ChangeOp.AddField("price", Map.of("label", "单价", "type", "number")),
                    // PERSISTED 计算字段：total = qty * price（expr 为结构化 ExpressionBinding）
                    new ChangeOp.AddField("total", Map.of(
                            "label", "合计", "type", "computed",
                            "computed", Map.of(
                                    "expr", Map.of("kind", "expr", "source", "qty * price"),
                                    "dependsOn", List.of("qty", "price"),
                                    "persistMode", "PERSISTED"))),
                    new ChangeOp.AddField("approver", Map.of("label", "审批人", "type", "user")),
                    new ChangeOp.AddField("dept", Map.of("label", "部门", "type", "dept")));
            Map<String, Object> pre = metadata.precheck(modelId, ops);
            String token = (String) pre.get("confirmToken");
            metadata.saveSchema(modelId, ops, 1, token, null);
            return null;
        });
    }

    // ---------- computed PERSISTED 重算 ----------

    @Test
    void computedOverwritesUserInput() {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("qty", 3);
        data.put("price", 7);
        data.put("total", 999999); // 伪造计算字段——必须被重算覆盖
        long id = TenantContext.with(T1, () -> (Long) engine.create(modelId, data).get("id"));

        Map<String, Object> detail = TenantContext.with(T1, () -> engine.getById(modelId, id));
        assertEquals(21, ((Number) detail.get("total")).intValue(), "计算字段必须按表达式重算（不可伪造）");
    }

    @Test
    void computedRecalculatedOnUpdate() {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("qty", 3);
        data.put("price", 7);
        long id = TenantContext.with(T1, () -> (Long) engine.create(modelId, data).get("id"));

        Map<String, Object> patch = new LinkedHashMap<>();
        patch.put("price", 10);
        TenantContext.with(T1, () -> {
            engine.update(modelId, id, patch);
            return null;
        });
        Map<String, Object> detail = TenantContext.with(T1, () -> engine.getById(modelId, id));
        assertEquals(30, ((Number) detail.get("total")).intValue(), "更新依赖字段后计算字段必须重算");
    }

    @Test
    void computedBrokenExprRejected() {
        // 表达式引用缺失字段（非 L1 编译错场景——字段缺失 FieldMissingError）：
        // 构造值不含 qty → 求值失败必须拒绝写入（不给配置坏=放行的旁路）
        long mid = TenantContext.with(T1, () ->
                Long.parseLong((String) metadata.createModel(
                        "writec_broken_" + System.nanoTime(), "坏表达式", null).get("id")));
        TenantContext.with(T1, () -> {
            List<ChangeOp> ops = List.of(
                    new ChangeOp.AddField("a", Map.of("label", "A", "type", "number")),
                    new ChangeOp.AddField("calc", Map.of(
                            "label", "计算", "type", "computed",
                            "computed", Map.of(
                                    "expr", Map.of("kind", "expr", "source", "a + missing_field"),
                                    "dependsOn", List.of("a"), "persistMode", "PERSISTED"))));
            Map<String, Object> pre = metadata.precheck(mid, ops);
            metadata.saveSchema(mid, ops, 1, (String) pre.get("confirmToken"), null);
            return null;
        });
        Map<String, Object> data = Map.of("a", 1);
        TenantContext.with(T1, () -> {
            BizException e = assertThrows(BizException.class, () -> engine.create(mid, data));
            assertEquals("VALIDATION_FAILED", e.code(), "计算字段求值失败必须拒绝写入");
            return null;
        });
    }

    // ---------- user/dept 引用存在性 ----------

    @Test
    void userReferenceMustExist() {
        // 不存在的用户 ID → 拒绝
        Map<String, Object> bad = new LinkedHashMap<>();
        bad.put("qty", 1);
        bad.put("price", 1);
        bad.put("approver", 999_999_999L);
        TenantContext.with(T1, () -> {
            BizException e = assertThrows(BizException.class, () -> engine.create(modelId, bad));
            assertEquals("VALIDATION_FAILED", e.code());
            assertTrue(e.getMessage().contains("approver"), "错误须定位到字段");
            return null;
        });
    }

    @Test
    void crossTenantUserReferenceRejected() {
        // 租户 2 用户存在但跨租户——引用必须不存在（同租户口径）
        Long otherTenantUser = jdbc.queryForObject(
                "INSERT INTO sys_user (tenant_id, account, name, password_hash, status, "
                        + "must_change_password, failed_attempts) "
                        + "VALUES (2, ?, ?, 'x', 'ACTIVE', false, 0) RETURNING id",
                Long.class, "xt_" + System.nanoTime(), "跨租户用户");
        Map<String, Object> bad = new LinkedHashMap<>();
        bad.put("qty", 1);
        bad.put("price", 1);
        bad.put("approver", otherTenantUser);
        TenantContext.with(T1, () -> {
            BizException e = assertThrows(BizException.class, () -> engine.create(modelId, bad));
            assertEquals("VALIDATION_FAILED", e.code(), "跨租户用户引用必须拒绝");
            return null;
        });
    }

    @Test
    void validUserAndDeptReferenceAccepted() {
        // 本租户真实用户 + 部门 → 放行
        Long userId = jdbc.queryForObject(
                "INSERT INTO sys_user (tenant_id, account, name, password_hash, status, "
                        + "must_change_password, failed_attempts) "
                        + "VALUES (1, ?, ?, 'x', 'ACTIVE', false, 0) RETURNING id",
                Long.class, "vu_" + System.nanoTime(), "本租户用户");
        Long deptId = jdbc.queryForObject(
                "INSERT INTO sys_dept (tenant_id, name) VALUES (1, ?) RETURNING id",
                Long.class, "测试部门_" + System.nanoTime());

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("qty", 2);
        data.put("price", 5);
        data.put("approver", userId);
        data.put("dept", deptId);
        long id = TenantContext.with(T1, () -> (Long) engine.create(modelId, data).get("id"));
        Map<String, Object> detail = TenantContext.with(T1, () -> engine.getById(modelId, id));
        assertEquals(userId.longValue(), ((Number) detail.get("approver")).longValue());
        assertEquals(deptId.longValue(), ((Number) detail.get("dept")).longValue());
    }

    // ---------- 字段元数据装载面 ----------

    @Test
    void visibleFieldViewsFilteredByFieldPerm() {
        // 种子管理员：全字段可见
        Map<String, Object> full = TenantContext.with(T1, () -> engine.visibleFieldViews(modelId));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> fields = (List<Map<String, Object>>) full.get("fields");
        assertEquals(5, fields.size(), "未配置字段权限时全 ACTIVE 字段可见");

        // 配置字段权限：只授权 qty 可见 → 未授权用户只见 qty
        Long roleId = jdbc.queryForObject(
                "INSERT INTO sys_role (tenant_id, code, name, role_type) "
                        + "VALUES (1, ?, ?, 'TENANT') RETURNING id",
                Long.class, "it_fv_" + System.nanoTime(), "字段视图测试角色");
        jdbc.update("INSERT INTO sys_role_data_scope (role_id, model_id, scope_type) "
                + "VALUES (?, ?, 'ALL')", roleId, modelId);
        jdbc.update("INSERT INTO sys_role_permission (role_id, resource_type, resource_id, action) "
                        + "VALUES (?, 'FIELD', ?, 'visible:qty')",
                roleId, modelId);
        // 造用户并绑定角色
        Long restrictedUserId = jdbc.queryForObject(
                "INSERT INTO sys_user (tenant_id, account, name, password_hash, status, "
                        + "must_change_password, failed_attempts) "
                        + "VALUES (1, ?, ?, 'x', 'ACTIVE', false, 0) RETURNING id",
                Long.class, "rv_" + System.nanoTime(), "受限用户");
        jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)",
                restrictedUserId, roleId);

        TenantInfo restricted = new TenantInfo(1, restrictedUserId, restrictedUserId);
        Map<String, Object> filtered = TenantContext.with(restricted,
                () -> engine.visibleFieldViews(modelId));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> visible = (List<Map<String, Object>>) filtered.get("fields");
        assertEquals(1, visible.size(), "已配置字段权限时仅授权集可见");
        assertEquals("qty", visible.get(0).get("fieldKey"));
    }
}
