package com.schema.app.domain.model;

import java.time.OffsetDateTime;

/**
 * 应用聚合根（13BE §3.1）。
 *
 * <p>应用是元数据/页面的顶级容器：一个应用持有自己的导航树、成员与发布记录。
 * 业务删除 = 逻辑删除（status='DELETED' + deleted_at），永不物理删行（后端总纲 §3 铁律）。
 *
 * <p>导航树乐观并发（§3.3）：navVersion 每次更新递增，更新时 WHERE nav_version = base，
 * 冲突返回 409 NAV_VERSION_CONFLICT。
 */
public class App {

    public enum Status { ACTIVE, ARCHIVED, DELETING }

    private final long id;
    private final long tenantId;
    private String name;
    private Long iconFileId;
    private String description;
    private String themeJson;      // JSONB 原始串（{logo, primaryColor, loginBg}）
    private String navTreeJson;    // 导航菜单树 JSON 原始串
    private int navVersion;
    private Status status;
    private OffsetDateTime deletedAt;
    private final Long createdBy;
    private final OffsetDateTime createdAt;
    private OffsetDateTime updatedAt;

    public App(long id, long tenantId, String name, Long iconFileId, String description,
               String themeJson, String navTreeJson, int navVersion, Status status,
               OffsetDateTime deletedAt, Long createdBy, OffsetDateTime createdAt, OffsetDateTime updatedAt) {
        this.id = id;
        this.tenantId = tenantId;
        this.name = name;
        this.iconFileId = iconFileId;
        this.description = description;
        this.themeJson = themeJson;
        this.navTreeJson = navTreeJson;
        this.navVersion = navVersion;
        this.status = status;
        this.deletedAt = deletedAt;
        this.createdBy = createdBy;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }

    // ---- 业务操作 ----

    /** 应用创建（初始导航树为空，版本 1）。 */
    public static App create(long tenantId, String name, Long iconFileId, String description,
                             String themeJson, Long createdBy) {
        return new App(0L, tenantId, name, iconFileId, description, themeJson,
                "[]", 1, Status.ACTIVE, null, createdBy, null, null);
    }

    /** 改名/图标/描述/主题。 */
    public void updateProfile(String name, Long iconFileId, String description, String themeJson) {
        this.name = name;
        this.iconFileId = iconFileId;
        this.description = description;
        this.themeJson = themeJson;
    }

    /**
     * 导航树乐观更新：基于 baseVersion 比对，冲突抛 {@link NavVersionConflictException}。
     * 调用方在持久化前必须用 {@code navVersion} 做 WHERE 条件二次校验（双保险）。
     */
    public void updateNavTree(String navTreeJson, int baseVersion) {
        if (this.navVersion != baseVersion) {
            throw new NavVersionConflictException(baseVersion, this.navVersion);
        }
        this.navTreeJson = navTreeJson;
        this.navVersion = this.navVersion + 1;
    }

    /** 逻辑归档（status → ARCHIVED）。 */
    public void archive() {
        if (this.status == Status.DELETING) {
            throw new IllegalStateException("应用正在删除中，不能归档");
        }
        this.status = Status.ARCHIVED;
    }

    /** 逻辑删除（status → DELETING，异步清理后 DELETED）。 */
    public void markDeleting() {
        if (this.status == Status.DELETING) {
            throw new IllegalStateException("应用已在删除流程中");
        }
        this.status = Status.DELETING;
        this.deletedAt = OffsetDateTime.now();
    }

    public boolean isActive() { return this.status == Status.ACTIVE; }

    // ---- 访问器 ----

    public long id() { return id; }
    public long tenantId() { return tenantId; }
    public String name() { return name; }
    public Long iconFileId() { return iconFileId; }
    public String description() { return description; }
    public String themeJson() { return themeJson; }
    public String navTreeJson() { return navTreeJson; }
    public int navVersion() { return navVersion; }
    public Status status() { return status; }
    public OffsetDateTime deletedAt() { return deletedAt; }
    public Long createdBy() { return createdBy; }
    public OffsetDateTime createdAt() { return createdAt; }
    public OffsetDateTime updatedAt() { return updatedAt; }
}