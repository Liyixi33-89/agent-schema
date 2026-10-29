package com.schema.page.domain.model;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 页面聚合（04BE §1）：草稿/发布态分离 + 版本递增。
 * 页面是单聚合根：draft/published 两态与版本不变式收口于此，接口层只做协议转换。
 */
public final class PageAggregate {

    private final long id;
    private final long tenantId;
    private final long appId;
    private String pageKey;
    private String name;
    private String pageType;
    private Long modelId;
    private String path;
    private int draftVersion;
    private int publishedVersion;       // 0 = 从未发布
    private String artifactHash;
    private String status;              // ACTIVE / DELETED

    private PageAggregate(long id, long tenantId, long appId, String pageKey, String name,
            String pageType, Long modelId, String path, int draftVersion, int publishedVersion,
            String artifactHash, String status) {
        this.id = id;
        this.tenantId = tenantId;
        this.appId = appId;
        this.pageKey = pageKey;
        this.name = name;
        this.pageType = pageType;
        this.modelId = modelId;
        this.path = path;
        this.draftVersion = draftVersion;
        this.publishedVersion = publishedVersion;
        this.artifactHash = artifactHash;
        this.status = status;
    }

    public static PageAggregate create(long tenantId, long appId, String pageKey, String name,
            String pageType, Long modelId, String path) {
        assertPageKey(pageKey);
        assertPath(path);
        assertPageType(pageType);
        return new PageAggregate(0, tenantId, appId, pageKey, name, pageType, modelId, path,
                1, 0, null, "ACTIVE");
    }

    public static PageAggregate restore(long id, long tenantId, long appId, String pageKey, String name,
            String pageType, Long modelId, String path, int draftVersion, int publishedVersion,
            String artifactHash, String status) {
        return new PageAggregate(id, tenantId, appId, pageKey, name, pageType, modelId, path,
                draftVersion, publishedVersion, artifactHash, status);
    }

    /** 草稿保存版本递增（baseDraftVersion 乐观锁在应用层校验）。 */
    public int nextDraftVersion() {
        return draftVersion + 1;
    }

    /** 发布版本递增（04BE §1.3：draft → published 全量拷贝；published_version++）。 */
    public int nextPublishedVersion() {
        if (publishedVersion == 0) {
            return 1;
        }
        return publishedVersion + 1;
    }

    public void rename(String name) {
        if (name != null && !name.isBlank()) {
            this.name = name;
        }
    }

    public void changePath(String path) {
        assertPath(path);
        this.path = path;
    }

    public void markDeleted() {
        this.status = "DELETED";
    }

    private static void assertPageKey(String pageKey) {
        if (pageKey == null || !pageKey.matches("[a-z][a-z0-9_]{0,63}")) {
            throw new IllegalArgumentException("pageKey 必须为小写字母开头的字母数字下划线（≤64 位）");
        }
    }

    private static void assertPath(String path) {
        if (path == null || !path.matches("/[A-Za-z0-9_/.-]{0,255}")) {
            throw new IllegalArgumentException("path 必须以 / 开头");
        }
    }

    private static void assertPageType(String pageType) {
        if (!java.util.List.of("FORM", "LIST", "DETAIL", "DASHBOARD").contains(pageType)) {
            throw new IllegalArgumentException("非法页面类型: " + pageType);
        }
    }

    public long id() { return id; }
    public long tenantId() { return tenantId; }
    public long appId() { return appId; }
    public String pageKey() { return pageKey; }
    public String name() { return name; }
    public String pageType() { return pageType; }
    public Long modelId() { return modelId; }
    public String path() { return path; }
    public int draftVersion() { return draftVersion; }
    public int publishedVersion() { return publishedVersion; }
    public String artifactHash() { return artifactHash; }
    public String status() { return status; }
    public boolean deleted() { return "DELETED".equals(status); }

    public Map<String, Object> summary() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", Long.toString(id));
        m.put("pageKey", pageKey);
        m.put("name", name);
        m.put("type", pageType);
        m.put("path", path);
        m.put("status", status);
        m.put("draftVersion", draftVersion);
        m.put("publishedVersion", publishedVersion);
        return m;
    }
}
