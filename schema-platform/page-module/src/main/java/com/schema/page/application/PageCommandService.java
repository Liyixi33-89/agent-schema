package com.schema.page.application;

import com.schema.page.domain.model.PageAggregate;
import com.schema.page.domain.repository.FieldReferencePort;
import com.schema.page.domain.repository.PageRepository;
import com.schema.page.domain.scan.FieldRefScanner;
import com.schema.platform.common.json.Json;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 页面应用服务（04BE §1/§A.1/§A.2/§A.4）：草稿 CRUD、发布快照、回滚、运行时读取（ETag）、字段引用登记。
 * 事务边界 = 单页面聚合；应用发布快照为跨页面聚合编排在同一事务内完成（单库原子性）。
 */
@Service
public class PageCommandService {

    private final PageRepository pages;
    private final FieldReferencePort references;

    public PageCommandService(PageRepository pages, FieldReferencePort references) {
        this.pages = pages;
        this.references = references;
    }

    // ---------- 页面 CRUD（§A.1） ----------

    @Transactional
    public Map<String, Object> createPage(long appId, String pageKey, String name, String pageType,
            Long modelId, String path) {
        TenantInfo tenant = TenantContext.get();
        PageAggregate page;
        try {
            page = PageAggregate.create(tenant.tenantId(), appId, pageKey, name, pageType, modelId, path);
        } catch (IllegalArgumentException e) {
            throw new BizException("PAGE_VALIDATION_FAILED", e.getMessage());
        }
        if (pages.existsByPageKey(tenant.tenantId(), appId, pageKey)) {
            throw new BizException("PAGE_KEY_DUPLICATED", "page_key 已存在: " + pageKey);
        }
        if (pages.existsByPath(tenant.tenantId(), path, 0)) {
            throw BizException.pathDuplicated();
        }
        Map<String, Object> draft = defaultDraft(page, pageKey, name, pageType, modelId, path);
        long id = pages.insertPage(page, Json.write(draft));
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("id", Long.toString(id));
        resp.put("draftVersion", 1);
        return resp;
    }

    public Map<String, Object> listPages(long appId, String keyword) {
        TenantInfo tenant = TenantContext.get();
        List<Map<String, Object>> list = new ArrayList<>();
        for (PageAggregate p : pages.listByApp(tenant.tenantId(), appId, keyword)) {
            list.add(p.summary());
        }
        return Map.of("list", list);
    }

    public Map<String, Object> getDraft(long pageId) {
        TenantInfo tenant = TenantContext.get();
        PageAggregate page = loadForTenant(pageId);
        String draftJson = pages.findDraft(tenant.tenantId(), pageId)
                .orElseThrow(() -> BizException.pageNotFound("页面 " + pageId));
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("schema", Json.readMap(draftJson));
        resp.put("draftVersion", page.draftVersion());
        return resp;
    }

    /** 草稿保存（§A.1：baseDraftVersion 乐观锁；自动保存/手动保存同接口）。 */
    @Transactional
    public Map<String, Object> saveDraft(long pageId, Map<String, Object> schema, int baseDraftVersion) {
        TenantInfo tenant = TenantContext.get();
        PageAggregate page = loadForTenant(pageId);
        if (schema == null) {
            throw new BizException("PAGE_VALIDATION_FAILED", "schema 缺失");
        }
        // path 以 schema 为真源（draft 内嵌路由），校验唯一性（排除自身）
        Object pathVal = schema.get("path");
        if (pathVal instanceof String newPath && !newPath.equals(page.path())
                && pages.existsByPath(tenant.tenantId(), newPath, pageId)) {
            throw BizException.pathDuplicated();
        }
        String draftJson = Json.write(schema);
        int updated = pages.saveDraft(tenant.tenantId(), pageId, draftJson, baseDraftVersion,
                tenant.operatorId());
        if (updated != 1) {
            throw BizException.draftVersionConflict();
        }

        // 字段引用登记（04BE §1.4：保存草稿全量重扫 → 登记；失败不阻断保存）
        syncFieldReferences(tenant, page, schema);

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("draftVersion", baseDraftVersion + 1);
        return resp;
    }

    /** 页面删除（逻辑删除 + 引用全清，04BE §1.4）。 */
    @Transactional
    public void deletePage(long pageId) {
        TenantInfo tenant = TenantContext.get();
        PageAggregate page = loadForTenant(pageId);
        if (page.deleted()) {
            return; // 幂等
        }
        pages.markDeleted(tenant.tenantId(), pageId);
        references.clearReferences(tenant.tenantId(), pageId);
    }

    /** 路径改名（§A.1：租户内唯一性校验）。 */
    @Transactional
    public void updatePath(long pageId, String path, String name) {
        TenantInfo tenant = TenantContext.get();
        PageAggregate page = loadForTenant(pageId);
        if (pages.existsByPath(tenant.tenantId(), path, pageId)) {
            throw BizException.pathDuplicated();
        }
        try {
            page.changePath(path);
        } catch (IllegalArgumentException e) {
            throw new BizException("PAGE_VALIDATION_FAILED", e.getMessage());
        }
        page.rename(name);
        pages.updatePath(tenant.tenantId(), pageId, page.path(), page.name());
    }

    // ---------- 发布与回滚（§A.2 / §1.3） ----------

    /**
     * 应用发布（04BE §1.3）：校验页面集 → draft → published 拷贝 + published_version++
     * → 页面发布版本全量固化（不可变）→ 聚合应用快照。
     */
    @Transactional
    public Map<String, Object> publish(long appId, List<Long> pageIds, String changelog) {
        TenantInfo tenant = TenantContext.get();
        if (pageIds == null || pageIds.isEmpty()) {
            pageIds = new ArrayList<>();
            for (PageAggregate p : pages.listByApp(tenant.tenantId(), appId, null)) {
                pageIds.add(p.id());
            }
        }

        List<Map<String, Object>> pageEntries = new ArrayList<>();
        for (Long pageId : pageIds) {
            PageAggregate page = loadForTenant(pageId);
            String draftJson = pages.findDraft(tenant.tenantId(), pageId)
                    .orElseThrow(() -> BizException.pageNotFound("页面 " + pageId));
            Map<String, Object> schema = Json.readMap(draftJson);

            int targetVersion = page.nextPublishedVersion();
            // 页面发布版本先落（不可变，§1.3 步骤 3——先写页面版本再聚合应用快照）
            pages.insertPageVersion(tenant.tenantId(), appId, pageId, targetVersion,
                    draftJson, page.artifactHash());
            int updated = pages.publish(tenant.tenantId(), pageId, draftJson, targetVersion,
                    page.artifactHash(), tenant.operatorId());
            if (updated != 1) {
                throw BizException.publishConflict();
            }

            // 发布时全量重扫登记（04BE §1.4：保存/发布时执行）
            syncFieldReferences(tenant, page, schema);

            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("pageId", Long.toString(pageId));
            entry.put("pageVersionRef", targetVersion);
            entry.put("schemaVersion", schema.get("schemaVersion"));
            entry.put("contentHash", page.artifactHash());
            pageEntries.add(entry);
        }

        int releaseVersion = pages.nextReleaseVersion(tenant.tenantId(), appId);
        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("pages", pageEntries);
        snapshot.put("modelRefs", List.of());
        pages.insertAppRelease(tenant.tenantId(), appId, releaseVersion, Json.write(snapshot),
                changelog, tenant.operatorId());

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("releaseVersion", releaseVersion);
        return resp;
    }

    public Map<String, Object> listReleases(long appId) {
        TenantInfo tenant = TenantContext.get();
        List<Map<String, Object>> list = new ArrayList<>();
        for (Map<String, Object> r : pages.listReleases(tenant.tenantId(), appId)) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("releaseVersion", ((Number) r.get("release_version")).intValue());
            Object rawChangelog = r.get("changelog");
            item.put("changelog", parseChangelog(rawChangelog));
            item.put("operator", String.valueOf(r.get("operator_id")));
            item.put("createdAt", r.get("created_at") == null ? null : r.get("created_at").toString());
            item.put("status", r.get("status"));
            list.add(item);
        }
        return Map.of("list", list);
    }

    /** changelog 兼容两种存储形态：JSON 对象（结构化）或 JSON 字符串（纯文本）。 */
    private static Object parseChangelog(Object raw) {
        if (!(raw instanceof String s) || s.isBlank()) {
            return raw;
        }
        String trimmed = s.trim();
        if (trimmed.startsWith("{")) {
            try {
                return Json.readMap(trimmed);
            } catch (Exception e) {
                return trimmed;
            }
        }
        if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length() >= 2) {
            // 存的是 JSON 字符串字面量——去掉包装引号并反转义
            return trimmed.substring(1, trimmed.length() - 1).replace("\\\"", "\"").replace("\\\\", "\\");
        }
        return trimmed;
    }

    /**
     * 回滚（04BE §1.3）：按历史 release 的 pages[].pageVersionRef 从 page_release_version
     * 取全量 Schema 回写 published——快照自包含，不依赖 draft 存活；回滚也是一次「发布」。
     */
    @Transactional
    public Map<String, Object> rollback(long appId, int targetReleaseVersion) {
        TenantInfo tenant = TenantContext.get();
        Map<String, Object> release = pages.findRelease(tenant.tenantId(), appId, targetReleaseVersion)
                .orElseThrow(() -> BizException.pageNotFound("发布版本 v" + targetReleaseVersion));
        if (!"ACTIVE".equals(release.get("status"))) {
            throw new BizException("RELEASE_ROLLED_BACK", "目标发布版本已被回滚，不可作为回滚目标");
        }
        Map<String, Object> snapshot = Json.readMap((String) release.get("snapshot"));
        Object rawPages = snapshot.get("pages");

        if (rawPages instanceof List<?> entries) {
            for (Object e : entries) {
                if (!(e instanceof Map<?, ?> entry)) {
                    continue;
                }
                long pageId = Long.parseLong(String.valueOf(entry.get("pageId")));
                int pageVersion = ((Number) entry.get("pageVersionRef")).intValue();
                PageAggregate page = loadForTenant(pageId);
                Map<String, Object> fixed = pages.findPageVersion(pageId, pageVersion)
                        .orElseThrow(() -> BizException.pageNotFound(
                                "页面 " + pageId + " 版本 v" + pageVersion));

                String schemaJson = (String) fixed.get("schema");
                Object artifactHash = fixed.get("artifact_hash");
                int targetVersion = page.nextPublishedVersion();
                pages.insertPageVersion(tenant.tenantId(), appId, pageId, targetVersion, schemaJson,
                        artifactHash instanceof String ah ? ah : null);
                int updated = pages.publish(tenant.tenantId(), pageId, schemaJson, targetVersion,
                        artifactHash instanceof String ah ? ah : null, tenant.operatorId());
                if (updated != 1) {
                    throw BizException.publishConflict();
                }
                // 回滚后引用面按固化快照重扫（快照自包含）
                syncFieldReferences(tenant, page, Json.readMap(schemaJson));
            }
        }
        // 目标版本置 ROLLED_BACK；本次回滚生成新 release（status=ACTIVE）
        pages.markReleaseRolledBack(tenant.tenantId(), appId, targetReleaseVersion);
        Map<String, Object> newSnapshot = new LinkedHashMap<>();
        newSnapshot.put("pages", rawPages);
        newSnapshot.put("modelRefs", List.of());
        newSnapshot.put("rolledBackFrom", targetReleaseVersion);
        int releaseVersion = pages.nextReleaseVersion(tenant.tenantId(), appId);
        pages.insertAppRelease(tenant.tenantId(), appId, releaseVersion, Json.write(newSnapshot),
                "rollback to v" + targetReleaseVersion, tenant.operatorId());

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("releaseVersion", releaseVersion);
        return resp;
    }

    // ---------- 运行时读取（§A.4 ETag 协议） ----------

    /**
     * 运行时读取（04BE §A.4）：If-None-Match 命中返回 null（304 由接口层写）；
     * 未发布返回 null（published IS NULL 不暴露给运行时）。
     */
    public RuntimePage getPublished(long pageId, String ifNoneMatch) {
        TenantInfo tenant = TenantContext.get();
        Map<String, Object> row = pages.findPublished(tenant.tenantId(), pageId)
                .orElse(null);
        if (row == null) {
            throw BizException.pageNotFound("页面 " + pageId + " 未发布或不存在");
        }
        String etag = "v" + ((Number) row.get("published_version")).intValue();
        if (etag.equals(ifNoneMatch)) {
            return new RuntimePage(etag, null);   // 304
        }
        return new RuntimePage(etag, Json.readMap((String) row.get("schema")));
    }

    public record RuntimePage(String etag, Map<String, Object> schema) {
        public boolean notModified() {
            return schema == null;
        }
    }

    // ---------- 内部 ----------

    private PageAggregate loadForTenant(long pageId) {
        TenantInfo tenant = TenantContext.get();
        return pages.findByIdAndTenant(pageId, tenant.tenantId())
                .orElseThrow(() -> BizException.pageNotFound("页面 " + pageId));
    }

    /** 引用登记（04BE §1.4）：全量重扫 → upsert；登记失败不阻断保存。 */
    private void syncFieldReferences(TenantInfo tenant, PageAggregate page, Map<String, Object> schema) {
        if (page.modelId() == null) {
            return;
        }
        try {
            FieldRefScanner.ScanResult result = FieldRefScanner.scan(schema);
            references.syncReferences(tenant.tenantId(), page.id(), page.modelId(),
                    List.copyOf(result.pageRefs()), List.copyOf(result.scriptRefs()));
        } catch (Exception e) {
            // 影响面数据允许短暂滞后（不可用阻断发布——登记失败不阻断保存/发布）
        }
    }

    /** 新建页面默认草稿（空布局 + 协议字段齐备）。 */
    private static Map<String, Object> defaultDraft(PageAggregate page, String pageKey, String name,
            String pageType, Long modelId, String path) {
        Map<String, Object> draft = new LinkedHashMap<>();
        draft.put("id", "pending");
        draft.put("pageKey", pageKey);
        draft.put("name", name);
        draft.put("type", pageType);
        if (modelId != null) {
            draft.put("modelId", Long.toString(modelId));
        }
        draft.put("path", path);
        draft.put("layout", List.of());
        draft.put("actions", List.of());
        draft.put("schemaVersion", 1);
        return draft;
    }
}
