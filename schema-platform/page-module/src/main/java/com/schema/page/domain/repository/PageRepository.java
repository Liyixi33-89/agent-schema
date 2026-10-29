package com.schema.page.domain.repository;

import com.schema.page.domain.model.PageAggregate;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 页面仓储（page_schema / page_release_version / app_release / 预览凭证表）。
 * 接口在 domain 层（DIP）；实现于 infrastructure（JDBC 显式租户谓词）。
 */
public interface PageRepository {

    long insertPage(PageAggregate page, String draftJson);

    boolean existsByPageKey(long tenantId, long appId, String pageKey);

    boolean existsByPath(long tenantId, String path, long excludePageId);

    Optional<PageAggregate> findByIdAndTenant(long pageId, long tenantId);

    /** 草稿保存（乐观锁：draft_version = baseDraftVersion 条件更新；成功则返回新版本）。 */
    int saveDraft(long tenantId, long pageId, String draftJson, int baseDraftVersion, long operatorId);

    Optional<String> findDraft(long tenantId, long pageId);

    /** 发布态写入（published_version 条件更新防并发发布跳号）。 */
    int publish(long tenantId, long pageId, String publishedJson, int targetVersion,
            String artifactHash, long operatorId);

    Optional<Map<String, Object>> findPublished(long tenantId, long pageId);

    List<PageAggregate> listByApp(long tenantId, long appId, String keyword);

    void markDeleted(long tenantId, long pageId);

    void updatePath(long tenantId, long pageId, String path, String name);

    // ---------- 页面发布版本（不可变，04BE §1.2） ----------

    /** 发布时全量固化（同版本冲突 = 并发发布竞态，调用方拒绝）。 */
    long insertPageVersion(long tenantId, long appId, long pageId, int pageVersion,
            String schemaJson, String artifactHash);

    Optional<Map<String, Object>> findPageVersion(long pageId, int pageVersion);

    // ---------- 应用发布快照（04BE §1.3） ----------

    int nextReleaseVersion(long tenantId, long appId);

    void insertAppRelease(long tenantId, long appId, int releaseVersion, String snapshotJson,
            String changelogJson, long operatorId);

    List<Map<String, Object>> listReleases(long tenantId, long appId);

    Optional<Map<String, Object>> findRelease(long tenantId, long appId, int releaseVersion);

    /** 回滚目标版本置 ROLLED_BACK（历史版本不再可用作再次回滚目标）。 */
    void markReleaseRolledBack(long tenantId, long appId, int releaseVersion);
}
