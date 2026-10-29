package com.schema.bootstrap;

import com.schema.iam.infrastructure.security.JwtCodec;
import com.schema.page.application.PageCommandService;
import com.schema.page.application.PreviewGrantService;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * M4 收口安全链集成测试（真实过滤器链 + 真实 PG）：
 * 匿名 exchange 公开放行 / 预览 token 端点隔离与限页 / 页面管理授权闸门 /
 * 路径并发唯一（V5 部分唯一索引）/ 引用全量重建（移除引用不残留）/ 跨应用发布拒绝。
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
class PageSecurityChainIT {

    @Autowired
    private WebApplicationContext ctx;

    @Autowired
    private JwtCodec jwt;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private PageCommandService pages;

    @Autowired
    private PreviewGrantService preview;

    private MockMvc mvc;

    private long designerId;
    private long plainId;
    private long pageId;
    private long modelId;

    @BeforeAll
    void setUp() {
        mvc = MockMvcBuilders.webAppContextSetup(ctx)
                .addFilters(ctx.getBeansOfType(jakarta.servlet.Filter.class).values()
                        .toArray(new jakarta.servlet.Filter[0]))
                .build();
        // 页面域数据清理（幂等重跑）
        jdbc.update("DELETE FROM page_preview_session");
        jdbc.update("DELETE FROM page_preview_grant");
        jdbc.update("DELETE FROM app_release");
        jdbc.update("DELETE FROM page_release_version");
        jdbc.update("DELETE FROM page_schema");
        jdbc.update("DELETE FROM meta_field_reference WHERE ref_type IN ('PAGE','SCRIPT')");

        // 种子角色：designer（page:design + app:publish）与 viewer（无页面权限点）——幂等种子
        Long designerRoleId = ensureRole("page_designer", "页面设计师");
        jdbc.update("INSERT INTO sys_role_permission (role_id, resource_type, resource_id, action) "
                + "VALUES (?, 'ACTION', 0, 'page:design') ON CONFLICT DO NOTHING", designerRoleId);
        jdbc.update("INSERT INTO sys_role_permission (role_id, resource_type, resource_id, action) "
                + "VALUES (?, 'ACTION', 0, 'app:publish') ON CONFLICT DO NOTHING", designerRoleId);
        // 04BE §A.7「应用开发者及以上可发起预览」——designer 角色补 preview:grant 权限点
        jdbc.update("INSERT INTO sys_role_permission (role_id, resource_type, resource_id, action) "
                + "VALUES (?, 'ACTION', 0, 'preview:grant') ON CONFLICT DO NOTHING", designerRoleId);
        Long viewerRoleId = ensureRole("page_viewer", "页面观察者");

        designerId = insertUser("page_designer_u");
        plainId = insertUser("page_plain_u");
        jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
                designerId, designerRoleId);
        jdbc.update("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
                plainId, viewerRoleId);

        // 测试页面：designer 身份创建（绕过 HTTP 保证独立于认证用例）
        TenantInfo designer = new TenantInfo(1, 1, designerId);
        long stamp = System.nanoTime();
        jdbc.update("INSERT INTO meta_model (tenant_id, app_id, model_key, name, current_version, status) "
                + "VALUES (1, 1, 'mdl_sec_" + stamp + "', '安全链模型', 1, 'ACTIVE')");
        modelId = jdbc.queryForObject(
                "SELECT id FROM meta_model WHERE model_key=?", Long.class, "mdl_sec_" + stamp);
        pageId = TenantContext.with(designer, () -> Long.parseLong((String) pages.createPage(
                1, "sec_page_" + stamp, "安全链页面", "FORM", modelId, "/sec/" + stamp).get("id")));
        TenantContext.clear();
    }

    private Long insertUser(String account) {
        List<Long> existing = jdbc.query(
                "SELECT id FROM sys_user WHERE tenant_id=1 AND account=? LIMIT 1",
                (rs, i) -> rs.getLong(1), account);
        if (!existing.isEmpty()) {
            return existing.get(0);
        }
        jdbc.update("INSERT INTO sys_user (tenant_id, account, name, password_hash, status) "
                + "VALUES (1, ?, ?, ?, 'ACTIVE')", account, account, "bcrypt-hash");
        return jdbc.queryForObject("SELECT id FROM sys_user WHERE account=?", Long.class, account);
    }

    /** 角色幂等种子（重跑不撞唯一约束）。 */
    private Long ensureRole(String code, String name) {
        List<Long> existing = jdbc.query(
                "SELECT id FROM sys_role WHERE tenant_id=1 AND code=? LIMIT 1",
                (rs, i) -> rs.getLong(1), code);
        if (!existing.isEmpty()) {
            return existing.get(0);
        }
        jdbc.update("INSERT INTO sys_role (tenant_id, code, name, role_type, app_id) "
                + "VALUES (1, ?, ?, 'APP', 1)", code, name);
        return jdbc.queryForObject(
                "SELECT id FROM sys_role WHERE tenant_id=1 AND code=?", Long.class, code);
    }

    private String access(long userId) {
        return jwt.issueAccess(userId, 1);
    }

    // ---------- 04BE §A.7：exchange 公开放行（匿名可兑换） ----------

    @Test
    void anonymousExchangeIsOpen() throws Exception {
        // designer 签发 grant
        TenantInfo designer = new TenantInfo(1, 1, designerId);
        Map<String, Object> grant = TenantContext.with(designer, () -> preview.issueGrant(1, pageId, false));
        String grantId = (String) grant.get("grantId");
        // 匿名兑换（无 Authorization 头）——此前被 JwtAuthFilter 401 挡死
        mvc.perform(post("/api/preview/exchange").contentType("application/json")
                        .content("{\"grantId\":\"" + grantId + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.previewSessionId").isNotEmpty())
                .andExpect(jsonPath("$.allowRealWrite").value(false));
    }

    // ---------- 04BE §A.7：预览 token 端点隔离（不得进入设计面/管理面） ----------

    @Test
    void previewTokenCannotAccessDesignOrAdminEndpoints() throws Exception {
        TenantInfo designer = new TenantInfo(1, 1, designerId);
        Map<String, Object> grant = TenantContext.with(designer, () -> preview.issueGrant(1, pageId, false));
        Map<String, Object> session = TenantContext.with(designer,
                () -> preview.exchange((String) grant.get("grantId")));
        String previewToken = (String) session.get("accessToken");

        // 设计面拒绝
        mvc.perform(get("/api/pages?appId=1").header("Authorization", "Bearer " + previewToken))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("PREVIEW_SCOPE_DENIED"));
        // 管理面拒绝（IAM）
        mvc.perform(get("/api/me").header("Authorization", "Bearer " + previewToken))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("PREVIEW_SCOPE_DENIED"));
        // 发布面拒绝
        mvc.perform(post("/api/apps/1/publish").header("Authorization", "Bearer " + previewToken)
                        .contentType("application/json").content("{}"))
                .andExpect(status().isForbidden());
        // 运行时读取面放行（已发布 200 / 未发布 404 均为业务语义——隔离白名单不拦）
        int runtimeStatus = mvc.perform(get("/api/runtime/pages/" + pageId)
                        .header("Authorization", "Bearer " + previewToken))
                .andReturn().getResponse().getStatus();
        assertTrue(runtimeStatus == 200 || runtimeStatus == 404,
                "预览 token 访问运行时面不得被隔离拦截，实际: " + runtimeStatus);
    }

    // ---------- 04BE §A.7：预览限页（会话绑定 pageId 时其他页不可见） ----------

    @Test
    void previewSessionIsPageScoped() throws Exception {
        TenantInfo designer = new TenantInfo(1, 1, designerId);
        // 先发布使 runtime 可读
        TenantContext.with(designer, () -> pages.publish(1, null, "预览限页测试"));
        Map<String, Object> grant = TenantContext.with(designer, () -> preview.issueGrant(1, pageId, false));
        Map<String, Object> session = TenantContext.with(designer,
                () -> preview.exchange((String) grant.get("grantId")));
        String previewToken = (String) session.get("accessToken");

        // 绑定页可读（200）
        mvc.perform(get("/api/runtime/pages/" + pageId)
                        .header("Authorization", "Bearer " + previewToken))
                .andExpect(status().isOk());
        // 其他页 404（应用级预览 pageId=null 时不受限——此处测绑定页）
        long ghost = pageId + 999999;
        mvc.perform(get("/api/runtime/pages/" + ghost)
                        .header("Authorization", "Bearer " + previewToken))
                .andExpect(status().isNotFound());
    }

    // ---------- 03BE §5 接线：页面管理授权闸门（HTTP 链） ----------

    @Test
    void plainMemberCannotDesignOrPublishPages() throws Exception {
        String token = access(plainId);
        long stamp = System.nanoTime();
        // 创建拒绝
        mvc.perform(post("/api/pages").header("Authorization", "Bearer " + token)
                        .contentType("application/json")
                        .content("{\"appId\":1,\"pageKey\":\"denied_" + stamp + "\",\"name\":\"D\","
                                + "\"type\":\"FORM\",\"path\":\"/denied/" + stamp + "\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("PERM_DENIED"));
        // 草稿保存拒绝
        mvc.perform(put("/api/pages/" + pageId + "/draft").header("Authorization", "Bearer " + token)
                        .contentType("application/json")
                        .content("{\"schema\":{},\"baseDraftVersion\":1}"))
                .andExpect(status().isForbidden());
        // 发布拒绝
        mvc.perform(post("/api/apps/1/publish").header("Authorization", "Bearer " + token)
                        .contentType("application/json").content("{}"))
                .andExpect(status().isForbidden());
        // 删除拒绝
        mvc.perform(delete("/api/pages/" + pageId).header("Authorization", "Bearer " + token))
                .andExpect(status().isForbidden());
    }

    @Test
    void designerCanSaveAndPublish() throws Exception {
        String token = access(designerId);
        int draftVersion = jdbc.queryForObject(
                "SELECT draft_version FROM page_schema WHERE id=?", Integer.class, pageId);
        String schema = "{\"id\":\"sec_" + System.nanoTime() + "\",\"pageKey\":\"sec\",\"name\":\"安全链页面\","
                + "\"type\":\"FORM\",\"modelId\":\"" + modelId + "\",\"path\":\"/sec/v2\",\"layout\":[],"
                + "\"actions\":[],\"schemaVersion\":1}";
        mvc.perform(put("/api/pages/" + pageId + "/draft").header("Authorization", "Bearer " + token)
                        .contentType("application/json")
                        .content("{\"schema\":" + schema + ",\"baseDraftVersion\":" + draftVersion + "}"))
                .andExpect(status().isOk());
        mvc.perform(post("/api/apps/1/publish").header("Authorization", "Bearer " + token)
                        .contentType("application/json").content("{\"changelog\":\"设计者发布\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.releaseVersion").isNumber());
    }

    // ---------- 04BE §A.1：路径并发唯一（V5 部分唯一索引兜底） ----------

    @Test
    void concurrentPathClaimHasExactlyOneWinner() throws Exception {
        String token = access(designerId);
        int threads = 6;
        String contestedPath = "/concurrent/" + System.nanoTime();
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch start = new CountDownLatch(1);
        AtomicLong okCount = new AtomicLong();
        AtomicLong rejectedCount = new AtomicLong();
        List<Future<int[]>> futures = new java.util.ArrayList<>();
        for (int i = 0; i < threads; i++) {
            final int idx = i;
            futures.add(pool.submit(() -> {
                start.await();
                try {
                    int st = mvc.perform(post("/api/pages").header("Authorization", "Bearer " + token)
                                    .contentType("application/json")
                                    .content("{\"appId\":1,\"pageKey\":\"race_" + idx + "_"
                                            + System.nanoTime() + "\",\"name\":\"R\",\"type\":\"FORM\","
                                            + "\"path\":\"" + contestedPath + "\"}"))
                            .andReturn().getResponse().getStatus();
                    return new int[]{st};
                } catch (Exception e) {
                    return new int[]{-1};
                }
            }));
        }
        start.countDown();
        for (Future<int[]> f : futures) {
            int st = f.get(20, TimeUnit.SECONDS)[0];
            if (st == 200) {
                okCount.incrementAndGet();
            } else if (st == 422) {
                rejectedCount.incrementAndGet();
            }
        }
        pool.shutdown();
        assertEquals(1, okCount.get(), "并发抢同一路径必须恰好一个成功");
        assertEquals(threads - 1, rejectedCount.get(), "其余全部 PATH_DUPLICATED 422");
    }

    // ---------- 04BE §1.4：引用全量重建（移除引用不残留） ----------

    @Test
    void removedFieldReferencesArePurgedOnResave() {
        TenantInfo designer = new TenantInfo(1, 1, designerId);
        // 保存带引用的草稿
        int baseVersion = jdbc.queryForObject(
                "SELECT draft_version FROM page_schema WHERE id=?", Integer.class, pageId);
        Map<String, Object> richDraft = Map.of(
                "id", "rich_" + System.nanoTime(),
                "pageKey", "sec", "name", "安全链页面", "type", "FORM",
                "modelId", Long.toString(modelId), "path", "/sec/rich",
                "layout", List.of(Map.of("id", "n1", "componentName", "Input", "fieldRef", "amount",
                        "props", Map.of())),
                "actions", List.of(), "schemaVersion", 1);
        TenantContext.with(designer, () -> pages.saveDraft(pageId, richDraft, baseVersion));
        Long registered = jdbc.queryForObject(
                "SELECT COUNT(*) FROM meta_field_reference WHERE model_id=? AND field_key='amount' "
                        + "AND ref_type='PAGE' AND ref_id=?", Long.class, modelId, pageId);
        assertTrue(registered != null && registered > 0, "保存后引用已登记");

        // 改为无引用草稿（fieldRef 移除）再保存 → 旧引用必须被清理
        int newBase = jdbc.queryForObject(
                "SELECT draft_version FROM page_schema WHERE id=?", Integer.class, pageId);
        Map<String, Object> emptyDraft = Map.of(
                "id", "empty_" + System.nanoTime(),
                "pageKey", "sec", "name", "安全链页面", "type", "FORM",
                "path", "/sec/empty", "layout", List.of(), "actions", List.of(), "schemaVersion", 1);
        TenantContext.with(designer, () -> pages.saveDraft(pageId, emptyDraft, newBase));
        Long remaining = jdbc.queryForObject(
                "SELECT COUNT(*) FROM meta_field_reference WHERE ref_id=?", Long.class, pageId);
        assertEquals(0L, remaining, "引用移除后不得残留（全量重建语义）");
    }

    // ---------- 04BE §1.3：跨应用发布拒绝 ----------

    @Test
    void crossAppPublishIsRejected() {
        TenantInfo designer = new TenantInfo(1, 1, designerId);
        BizExceptionHolder holder = new BizExceptionHolder();
        TenantContext.with(designer, () -> {
            try {
                pages.publish(999, List.of(pageId), "跨应用");
            } catch (com.schema.platform.common.web.BizException e) {
                holder.code = e.code();
            }
            return null;
        });
        assertEquals("PAGE_NOT_FOUND", holder.code, "跨应用页面混入发布集同判不存在");
    }

    private static class BizExceptionHolder {
        String code;
    }
}
