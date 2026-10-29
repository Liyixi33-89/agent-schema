package com.schema.bootstrap;

import com.schema.metadata.application.MetadataCommandService;
import com.schema.page.application.PageCommandService;
import com.schema.page.application.PreviewGrantService;
import com.schema.page.domain.scan.FieldRefScanner;
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
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * M4 集成测试（真实 PG，04BE §4 硬性要求）：
 * 发布 ETag / 草稿发布态隔离 / 回滚快照自包含 / 五位置引用扫描 / 预览凭证闭环。
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
class PageServiceIT {

    @Autowired
    private PageCommandService pages;

    @Autowired
    private PreviewGrantService preview;

    @Autowired
    private MetadataCommandService metadata;

    @Autowired
    private JdbcTemplate jdbc;

    private long modelId;
    private long pageId;

    @BeforeAll
    void warmup() {
        // 清理本测试的历史数据（幂等重跑）
        jdbc.update("DELETE FROM page_preview_session");
        jdbc.update("DELETE FROM page_preview_grant");
        jdbc.update("DELETE FROM app_release");
        jdbc.update("DELETE FROM page_release_version");
        jdbc.update("DELETE FROM page_schema");
        jdbc.update("DELETE FROM meta_field_reference");
    }

    @BeforeEach
    void setUp() {
        TenantInfo tenant = new TenantInfo(1, 1, 1);
        long stamp = System.nanoTime();
        modelId = TenantContext.with(tenant, () ->
                Long.parseLong((String) metadata.createModel("mdl_" + stamp, "报销单", null).get("id")));
        pageId = TenantContext.with(tenant, () -> Long.parseLong(
                (String) pages.createPage(1, "page_" + stamp, "报销登记页", "FORM", modelId, "/expense/" + stamp).get("id")));
    }

    @AfterEach
    void cleanup() {
        TenantContext.clear();
    }

    private TenantInfo t() {
        return new TenantInfo(1, 1, 1);
    }

    /** 构造带五位置引用的页面草稿（fieldRef / dependsOn / filter / aggregate / script）。 */
    private Map<String, Object> richDraft() {
        return Map.of(
                "pageKey", "rich",
                "name", "富引用页",
                "type", "LIST",
                "modelId", Long.toString(modelId),
                "path", "/rich",
                "schemaVersion", 1,
                "layout", List.of(
                        Map.of("id", "n1", "componentName", "Table", "fieldRef", "amount",
                                "props", Map.of(
                                        "title", Map.of("kind", "expr", "source", "amount", "dependsOn", List.of("title")),
                                        "children", List.of())),
                        Map.of("id", "n2", "componentName", "Input", "fieldRef", "owner")),
                "dataSource", Map.of(
                        "type", "MODEL_LIST",
                        "modelId", Long.toString(modelId),
                        "filter", Map.of("and", List.of(
                                Map.of("field", "status", "op", "eq", "value", "DRAFT"),
                                Map.of("or", List.of(Map.of("field", "amount", "op", "gt", "value", 100))))),
                        "sort", List.of(Map.of("field", "createdAt", "order", "desc")),
                        "aggregate", Map.of(
                                "measures", List.of(Map.of("fieldKey", "amount", "func", "SUM"),
                                        Map.of("fieldKey", "__count", "func", "COUNT")),
                                "group", Map.of("fieldKey", "dept"),
                                "timeBucket", Map.of("fieldKey", "createdAt", "interval", "DAY"))),
                "actions", List.of(),
                "scripts", List.of(Map.of("content",
                        "function onSubmit(ctx) { const a = ctx.form.get('amount'); ctx.form.set('remark', a); }")));
    }

    // ---------- 04BE §4：发布后运行时返回新版 ETag；未发布 draft 不影响 published 读取 ----------

    @Test
    void publishProducesEtagAndDraftDoesNotLeak() {
        // 未发布 → 运行时读取 404
        BizException unpublished = TenantContext.with(t(), () ->
                assertThrows(BizException.class, () -> pages.getPublished(pageId, null)));
        assertEquals("PAGE_NOT_FOUND", unpublished.code());

        // 发布 → ETag v1
        Map<String, Object> published = TenantContext.with(t(), () -> pages.publish(1, null, "首次发布"));
        assertEquals(1, ((Number) published.get("releaseVersion")).intValue());

        PageCommandService.RuntimePage v1 = TenantContext.with(t(), () -> pages.getPublished(pageId, null));
        assertEquals("v1", v1.etag());
        assertNotNull(v1.schema());

        // If-None-Match 命中 → 304
        PageCommandService.RuntimePage unchanged = TenantContext.with(t(), () -> pages.getPublished(pageId, "v1"));
        assertTrue(unchanged.notModified());

        // 草稿继续编辑不影响 published（draft_version 递增，published 仍 v1）
        TenantContext.with(t(), () -> pages.saveDraft(pageId, richDraft(), 1));
        PageCommandService.RuntimePage stillV1 = TenantContext.with(t(), () -> pages.getPublished(pageId, "v1"));
        assertTrue(stillV1.notModified(), "draft 保存不得影响 published ETag");

        // 再发布 → v2
        TenantContext.with(t(), () -> pages.publish(1, null, null));
        PageCommandService.RuntimePage v2 = TenantContext.with(t(), () -> pages.getPublished(pageId, "v1"));
        assertEquals("v2", v2.etag());
        assertNotNull(v2.schema());
    }

    // ---------- 04BE §4：回滚 = 新发布版本；快照自包含（不依赖 draft 存活） ----------

    @Test
    void rollbackRestoresImmutableSnapshot() {
        // r1：初始草稿直接发布
        int r1 = ((Number) TenantContext.with(t(), () -> pages.publish(1, null, "r1")).get("releaseVersion")).intValue();

        // r2：改成富引用草稿再发布
        TenantContext.with(t(), () -> pages.saveDraft(pageId, richDraft(), 1));
        int r2 = ((Number) TenantContext.with(t(), () -> pages.publish(1, null, "r2")).get("releaseVersion")).intValue();
        assertEquals(r1 + 1, r2);
        PageCommandService.RuntimePage afterR2 = TenantContext.with(t(), () -> pages.getPublished(pageId, null));
        assertEquals("v2", afterR2.etag());

        // 回滚到 r1（页面内容回到 v1 时刻）
        Map<String, Object> rollback = TenantContext.with(t(), () -> pages.rollback(1, r1));
        int r3 = ((Number) rollback.get("releaseVersion")).intValue();
        assertEquals(r2 + 1, r3, "回滚也是一次发布（新版本号）");

        PageCommandService.RuntimePage afterRollback = TenantContext.with(t(), () -> pages.getPublished(pageId, "v2"));
        assertEquals("v3", afterRollback.etag(), "回滚后页面版本递增（不是回退）");
        // 快照自包含：回滚后 published 内容 = r1 固化的 v1 页面内容（非当前 draft）
        Object layout = afterRollback.schema().get("layout");
        assertTrue(layout instanceof List<?> l && l.isEmpty(), "回滚恢复的是 v1 时刻的空布局（快照自包含）");

        // 被回滚的 r1 不可再次作为回滚目标
        final int target = r1;
        BizException rolledBack = TenantContext.with(t(), () ->
                assertThrows(BizException.class, () -> pages.rollback(1, target)));
        assertEquals("RELEASE_ROLLED_BACK", rolledBack.code());

        // 回滚产生的 r3 为 ACTIVE（可作为后续回滚目标）
        Map<String, Object> releases = TenantContext.with(t(), () -> pages.listReleases(1));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> list = (List<Map<String, Object>>) releases.get("list");
        assertEquals("ACTIVE", list.get(0).get("status"), "回滚产生的新 release 为 ACTIVE");
    }

    // ---------- 04BE §4 / §1.4：五位置引用扫描 → meta_field_reference 登记 ----------

    @Test
    void fieldReferencesRegisteredOnSaveAndPublish() {
        // 保存富引用草稿 → 引用登记（04BE §1.4：保存草稿时执行）
        TenantContext.with(t(), () -> pages.saveDraft(pageId, richDraft(), 1));

        List<String> pageRefs = List.of("amount", "title", "owner", "status", "dept", "createdAt");
        for (String fieldKey : pageRefs) {
            Long count = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM meta_field_reference WHERE model_id=? AND field_key=? AND ref_type='PAGE' AND ref_id=?",
                    Long.class, modelId, fieldKey, pageId);
            assertTrue(count != null && count > 0, "PAGE 引用未登记: " + fieldKey);
        }
        // SCRIPT 引用：amount（get）+ remark（set）
        for (String fieldKey : List.of("amount", "remark")) {
            Long count = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM meta_field_reference WHERE model_id=? AND field_key=? AND ref_type='SCRIPT' AND ref_id=?",
                    Long.class, modelId, fieldKey, pageId);
            assertTrue(count != null && count > 0, "SCRIPT 引用未登记: " + fieldKey);
        }
        // __count 伪字段不登记
        Long pseudo = jdbc.queryForObject(
                "SELECT COUNT(*) FROM meta_field_reference WHERE field_key='__count'", Long.class);
        assertEquals(0L, pseudo);

        // 删除页面 → 引用全清（01BE §A.4）
        TenantContext.with(t(), () -> {
            pages.deletePage(pageId);
            return null;
        });
        Long remaining = jdbc.queryForObject(
                "SELECT COUNT(*) FROM meta_field_reference WHERE ref_id=?", Long.class, pageId);
        assertEquals(0L, remaining, "页面删除必须全清引用");

        // 删除幂等
        TenantContext.with(t(), () -> {
            pages.deletePage(pageId);
            return null;
        });
    }

    /** 扫描器单元断言：五位置逐项覆盖（无 DB 依赖）。 */
    @Test
    void scannerExtractsAllFivePositions() {
        FieldRefScanner.ScanResult result = FieldRefScanner.scan(richDraft());
        assertTrue(result.pageRefs().containsAll(
                List.of("amount", "title", "owner", "status", "dept", "createdAt")));
        assertTrue(result.scriptRefs().containsAll(List.of("amount", "remark")));
        assertFalse(result.pageRefs().contains("__count"));
    }

    private static void assertFalse(boolean v) {
        org.junit.jupiter.api.Assertions.assertFalse(v);
    }

    // ---------- 04BE §A.1：草稿乐观锁 409 ----------

    @Test
    void draftVersionConflictDetected() {
        TenantContext.with(t(), () -> pages.saveDraft(pageId, richDraft(), 1));
        // baseDraftVersion 过期（服务端已 2）
        BizException conflict = TenantContext.with(t(), () ->
                assertThrows(BizException.class, () -> pages.saveDraft(pageId, richDraft(), 1)));
        assertEquals("DRAFT_VERSION_CONFLICT", conflict.code());
        // 正确版本可用
        Map<String, Object> saved = TenantContext.with(t(), () -> pages.saveDraft(pageId, richDraft(), 2));
        assertEquals(3, ((Number) saved.get("draftVersion")).intValue());
    }

    // ---------- 04BE §A.1：路径租户内唯一 ----------

    @Test
    void pathUniquenessEnforced() {
        long stamp = System.nanoTime();
        long other = TenantContext.with(t(), () -> Long.parseLong(
                (String) pages.createPage(1, "other_" + stamp, "其他页", "FORM", modelId, "/other/" + stamp).get("id")));
        // 自身路径从 DB 反查（setUp 用唯一路径，不硬编码）
        String selfPath = jdbc.queryForObject(
                "SELECT path FROM page_schema WHERE id=?", String.class, pageId);
        // 与自身同路径改名允许；与他人冲突拒绝
        TenantContext.with(t(), () -> {
            pages.updatePath(pageId, selfPath, "改名");
            return null;
        });
        BizException duplicated = TenantContext.with(t(), () ->
                assertThrows(BizException.class, () -> pages.updatePath(other, selfPath, null)));
        assertEquals("PATH_DUPLICATED", duplicated.code());
    }

    // ---------- 04BE §A.7：预览凭证闭环 ----------

    @Test
    void previewGrantLifecycle() {
        long operatorId = ensurePreviewOperator();
        TenantInfo adminTenant = new TenantInfo(1, 1, operatorId);
        // 签发（无 org:manage 的操作者被拒；专用操作者放行）
        BizException denied = TenantContext.with(t(), () ->
                assertThrows(BizException.class, () -> preview.issueGrant(1, pageId, false)));
        assertEquals("PERM_DENIED", denied.code());

        Map<String, Object> grant = TenantContext.with(adminTenant, () -> preview.issueGrant(1, pageId, false));
        String grantId = (String) grant.get("grantId");
        assertNotNull(grantId);
        assertEquals(300, ((Number) grant.get("expiresIn")).intValue());

        // 兑换：grant 用后即毁
        Map<String, Object> session = TenantContext.with(adminTenant, () -> preview.exchange(grantId));
        assertNotNull(session.get("accessToken"));
        assertEquals(Boolean.FALSE, session.get("allowRealWrite"), "默认只读预览");
        assertNotNull(session.get("previewSessionId"));

        // 重放 → 401 GRANT_CONSUMED
        BizException replay = TenantContext.with(adminTenant, () ->
                assertThrows(BizException.class, () -> preview.exchange(grantId)));
        assertEquals("GRANT_CONSUMED", replay.code());

        // 单会话吊销 → validateSession 401 PREVIEW_SESSION_REVOKED
        String sessionUuid = (String) session.get("previewSessionId");
        TenantContext.with(adminTenant, () -> {
            preview.revokeSession(sessionUuid);
            return null;
        });
        BizException revoked = assertThrows(BizException.class, () ->
                preview.validateSession(sessionUuid));
        assertEquals("PREVIEW_SESSION_REVOKED", revoked.code());

        // 吊销全部：未用 grant 即时失效 + 在途会话下一请求 401
        Map<String, Object> grant2 = TenantContext.with(adminTenant, () -> preview.issueGrant(1, null, true));
        Map<String, Object> session2 = TenantContext.with(adminTenant, () -> preview.exchange((String) grant2.get("grantId")));
        Map<String, Object> revokedAll = TenantContext.with(adminTenant, () -> preview.revokeAll(1));
        assertTrue(((Number) revokedAll.get("revokedSessions")).intValue() >= 1);
        BizException revoked2 = assertThrows(BizException.class, () ->
                preview.validateSession((String) session2.get("previewSessionId")));
        assertEquals("PREVIEW_SESSION_REVOKED", revoked2.code(), "吊销后在途会话下一请求即失效");
        // 再签发一个未用 grant 验证 revokeAll 的 grant 面覆盖（吊销数 ≥1）
        Map<String, Object> grant3 = TenantContext.with(adminTenant, () -> preview.issueGrant(1, null, false));
        Map<String, Object> revokedAgain = TenantContext.with(adminTenant, () -> preview.revokeAll(1));
        assertTrue(((Number) revokedAgain.get("revokedGrants")).intValue() >= 1, "revokeAll 吊销未用 grant");
        BizException consumed = TenantContext.with(adminTenant, () ->
                assertThrows(BizException.class, () -> preview.exchange((String) grant3.get("grantId"))));
        assertEquals("GRANT_CONSUMED", consumed.code(), "被吊销的未用 grant 不可再兑换");
    }

    /** 专用预览操作者（tenant 1 + org:manage）：不存在则建号（密码随机不入断言）。 */
    private long ensurePreviewOperator() {
        List<Long> existing = jdbc.query(
                "SELECT id FROM sys_user WHERE tenant_id=1 AND account='preview_operator' LIMIT 1",
                (rs, i) -> rs.getLong(1));
        long userId;
        if (existing.isEmpty()) {
            var encoder = new org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder();
            jdbc.update("INSERT INTO sys_user (tenant_id, account, name, password_hash, status, must_change_password) "
                            + "VALUES (1, 'preview_operator', '预览测试员', ?, 'ACTIVE', false)",
                    encoder.encode("Preview!2026x"));
            userId = jdbc.queryForObject(
                    "SELECT id FROM sys_user WHERE tenant_id=1 AND account='preview_operator'", Long.class);
        } else {
            userId = existing.get(0);
        }
        // 授 org:manage 角色组
        List<Long> roleIds = jdbc.query(
                "SELECT id FROM sys_role WHERE tenant_id=1 AND code='preview-test-admin' LIMIT 1",
                (rs, i) -> rs.getLong(1));
        long roleId;
        if (roleIds.isEmpty()) {
            jdbc.update("INSERT INTO sys_role (tenant_id, code, name, role_type) "
                    + "VALUES (1, 'preview-test-admin', '预览测试管理员', 'TENANT')");
            roleId = jdbc.queryForObject(
                    "SELECT id FROM sys_role WHERE tenant_id=1 AND code='preview-test-admin'", Long.class);
        } else {
            roleId = roleIds.get(0);
        }
        jdbc.update("INSERT INTO sys_role_permission (role_id, resource_type, resource_id, action) "
                        + "VALUES (?, 'ACTION', 0, 'org:manage') ON CONFLICT DO NOTHING", roleId);
        jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
                userId, roleId);
        return userId;
    }

    // ---------- 租户隔离 ----------

    @Test
    void tenantIsolationOnPageRead() {
        TenantInfo other = new TenantInfo(2, 1, 1);
        BizException cross = TenantContext.with(other, () ->
                assertThrows(BizException.class, () -> pages.getDraft(pageId)));
        assertEquals("PAGE_NOT_FOUND", cross.code(), "跨租户同判不存在");
    }
}
