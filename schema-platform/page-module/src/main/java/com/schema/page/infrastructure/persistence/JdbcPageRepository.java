package com.schema.page.infrastructure.persistence;

import com.schema.page.domain.model.PageAggregate;
import com.schema.page.domain.repository.PageRepository;
import com.schema.platform.common.json.Json;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * page_schema / page_release_version / app_release 仓储实现。
 * 显式租户谓词（跨模块 join 禁止——0BE §模块边界）；一次性语义靠条件 UPDATE 行数。
 */
@Repository
public class JdbcPageRepository implements PageRepository {

    private final JdbcTemplate jdbc;

    public JdbcPageRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public long insertPage(PageAggregate p, String draftJson) {
        try {
            jdbc.update("""
                    INSERT INTO page_schema (tenant_id, app_id, page_key, name, page_type, model_id, path,
                      draft, draft_version, status, updated_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, 'ACTIVE', ?)
                    """, p.tenantId(), p.appId(), p.pageKey(), p.name(), p.pageType(), p.modelId(), p.path(),
                    draftJson, p.draftVersion(), operator());
        } catch (org.springframework.dao.DuplicateKeyException e) {
            // V5 唯一索引兜底：并发 create 撞路径/撞 pageKey（应用层先查后写的 TOCTOU 窗口）
            if (e.getMessage() != null && e.getMessage().contains("uq_page_path_active")) {
                throw com.schema.platform.common.web.BizException.pathDuplicated();
            }
            throw e;
        }
        return jdbc.queryForObject("SELECT id FROM page_schema WHERE tenant_id=? AND app_id=? AND page_key=?",
                Long.class, p.tenantId(), p.appId(), p.pageKey());
    }

    private static Long operator() {
        return null; // updated_by 由应用层经 TenantContext 填充（仓储不读上下文）
    }

    @Override
    public boolean existsByPageKey(long tenantId, long appId, String pageKey) {
        Long n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM page_schema WHERE tenant_id=? AND app_id=? AND page_key=? AND status='ACTIVE'",
                Long.class, tenantId, appId, pageKey);
        return n != null && n > 0;
    }

    @Override
    public boolean existsByPath(long tenantId, String path, long excludePageId) {
        Long n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM page_schema WHERE tenant_id=? AND path=? AND id<>? AND status='ACTIVE'",
                Long.class, tenantId, path, excludePageId);
        return n != null && n > 0;
    }

    @Override
    public Optional<PageAggregate> findByIdAndTenant(long pageId, long tenantId) {
        List<PageAggregate> rows = jdbc.query(
                "SELECT * FROM page_schema WHERE id=? AND tenant_id=?",
                (rs, i) -> PageAggregate.restore(
                        rs.getLong("id"), rs.getLong("tenant_id"), rs.getLong("app_id"),
                        rs.getString("page_key"), rs.getString("name"), rs.getString("page_type"),
                        rs.getObject("model_id") instanceof Number n ? n.longValue() : null,
                        rs.getString("path"), rs.getInt("draft_version"),
                        rs.getObject("published_version") instanceof Number n ? n.intValue() : 0,
                        rs.getString("artifact_hash"), rs.getString("status")),
                pageId, tenantId);
        return rows.stream().findFirst();
    }

    @Override
    public int saveDraft(long tenantId, long pageId, String draftJson, int baseDraftVersion, long operatorId) {
        // path 单一真源同步：draft 内嵌路由为真源，保存时同步 page_schema.path
        // （此前双真源漂移——draft.path 改了但页面表 path 不动，existsByPath 判定基于旧值）
        String pathInDraft = null;
        try {
            com.google.gson.JsonObject node = com.schema.platform.common.json.Json.parseObject(draftJson);
            if (node != null && node.has("path") && !node.get("path").isJsonNull()) {
                pathInDraft = node.get("path").getAsString();
            }
        } catch (Exception ignored) {
            // draft 非法 JSON 走原路径（应用层已先行校验，此处兜底不吞语义异常）
        }
        if (pathInDraft != null && !pathInDraft.isBlank()) {
            try {
                return jdbc.update("""
                        UPDATE page_schema SET draft=?::jsonb, draft_version=draft_version+1, path=?,
                          updated_by=?, updated_at=now()
                        WHERE id=? AND tenant_id=? AND draft_version=? AND status='ACTIVE'
                        """, draftJson, pathInDraft, operatorId, pageId, tenantId, baseDraftVersion);
            } catch (org.springframework.dao.DuplicateKeyException e) {
                // V5 唯一索引兜底：并发保存撞他人路径（先查后写 TOCTOU 窗口）
                throw com.schema.platform.common.web.BizException.pathDuplicated();
            }
        }
        return jdbc.update("""
                UPDATE page_schema SET draft=?::jsonb, draft_version=draft_version+1, updated_by=?, updated_at=now()
                WHERE id=? AND tenant_id=? AND draft_version=? AND status='ACTIVE'
                """, draftJson, operatorId, pageId, tenantId, baseDraftVersion);
    }

    @Override
    public Optional<String> findDraft(long tenantId, long pageId) {
        List<String> rows = jdbc.query(
                "SELECT draft::text FROM page_schema WHERE id=? AND tenant_id=?",
                (rs, i) -> rs.getString(1), pageId, tenantId);
        return rows.stream().findFirst();
    }

    @Override
    public int publish(long tenantId, long pageId, String publishedJson, int targetVersion,
            String artifactHash, long operatorId) {
        // published_version 为 NULL 或 = targetVersion-1 才更新（防并发发布跳号/覆写）
        return jdbc.update("""
                UPDATE page_schema SET published=?::jsonb, published_version=?, artifact_hash=?,
                  schema_etag=?, updated_by=?, updated_at=now()
                WHERE id=? AND tenant_id=?
                  AND (published_version IS NULL AND ?=1 OR published_version=?)
                """, publishedJson, targetVersion, artifactHash, "v" + targetVersion,
                operatorId, pageId, tenantId, targetVersion, targetVersion - 1);
    }

    @Override
    public Optional<Map<String, Object>> findPublished(long tenantId, long pageId) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT published::text AS schema, published_version, artifact_hash, schema_etag "
                        + "FROM page_schema WHERE id=? AND tenant_id=? AND published IS NOT NULL AND status='ACTIVE'",
                pageId, tenantId);
        return rows.stream().findFirst();
    }

    @Override
    public List<PageAggregate> listByApp(long tenantId, long appId, String keyword) {
        String sql = "SELECT * FROM page_schema WHERE tenant_id=? AND app_id=? AND status='ACTIVE'";
        List<Object> args = new ArrayList<>(List.of(tenantId, appId));
        if (keyword != null && !keyword.isBlank()) {
            sql += " AND (name ILIKE ? OR page_key ILIKE ?)";
            args.add("%" + keyword + "%");
            args.add("%" + keyword + "%");
        }
        sql += " ORDER BY id";
        return jdbc.query(sql, (rs, i) -> PageAggregate.restore(
                rs.getLong("id"), rs.getLong("tenant_id"), rs.getLong("app_id"),
                rs.getString("page_key"), rs.getString("name"), rs.getString("page_type"),
                rs.getObject("model_id") instanceof Number n ? n.longValue() : null,
                rs.getString("path"), rs.getInt("draft_version"),
                rs.getObject("published_version") instanceof Number n ? n.intValue() : 0,
                rs.getString("artifact_hash"), rs.getString("status")), args.toArray());
    }

    @Override
    public void markDeleted(long tenantId, long pageId) {
        jdbc.update("UPDATE page_schema SET status='DELETED', updated_at=now() WHERE id=? AND tenant_id=?",
                pageId, tenantId);
    }

    @Override
    public void updatePath(long tenantId, long pageId, String path, String name) {
        try {
            if (name != null && !name.isBlank()) {
                jdbc.update("UPDATE page_schema SET path=?, name=?, updated_at=now() WHERE id=? AND tenant_id=?",
                        path, name, pageId, tenantId);
            } else {
                jdbc.update("UPDATE page_schema SET path=?, updated_at=now() WHERE id=? AND tenant_id=?",
                        path, pageId, tenantId);
            }
        } catch (org.springframework.dao.DuplicateKeyException e) {
            // V5 唯一索引兜底（并发改名撞他人路径）
            throw com.schema.platform.common.web.BizException.pathDuplicated();
        }
    }

    // ---------- 页面发布版本（不可变） ----------

    @Override
    public long insertPageVersion(long tenantId, long appId, long pageId, int pageVersion,
            String schemaJson, String artifactHash) {
        jdbc.update("""
                INSERT INTO page_release_version (tenant_id, app_id, page_id, page_version, schema, artifact_hash)
                VALUES (?, ?, ?, ?, ?::jsonb, ?)
                """, tenantId, appId, pageId, pageVersion, schemaJson, artifactHash);
        return jdbc.queryForObject(
                "SELECT id FROM page_release_version WHERE page_id=? AND page_version=?",
                Long.class, pageId, pageVersion);
    }

    @Override
    public Optional<Map<String, Object>> findPageVersion(long pageId, int pageVersion) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT schema::text AS schema, artifact_hash, id AS version_ref "
                        + "FROM page_release_version WHERE page_id=? AND page_version=?",
                pageId, pageVersion);
        return rows.stream().findFirst();
    }

    // ---------- 应用发布快照 ----------

    @Override
    public int nextReleaseVersion(long tenantId, long appId) {
        // 空 MAX 集返回 NULL——流式 Optional.of 会 NPE，改 query 直接判空
        List<Integer> max = jdbc.query(
                "SELECT MAX(release_version) FROM app_release WHERE tenant_id=? AND app_id=?",
                (rs, i) -> rs.getObject(1) instanceof Number n ? n.intValue() : 0,
                tenantId, appId);
        return (max.isEmpty() ? 0 : max.get(0)) + 1;
    }

    @Override
    public void insertAppRelease(long tenantId, long appId, int releaseVersion, String snapshotJson,
            String changelogJson, long operatorId) {
        // changelog 为纯文本时包 JSON 字符串；调用方传 JSON 对象文本则原样入 jsonb
        String changelogValue;
        if (changelogJson == null) {
            changelogValue = null;
        } else if (changelogJson.trim().startsWith("{")) {
            changelogValue = changelogJson;
        } else {
            changelogValue = Json.write(changelogJson);
        }
        jdbc.update("""
                INSERT INTO app_release (tenant_id, app_id, release_version, snapshot, changelog, operator_id, status)
                VALUES (?, ?, ?, ?::jsonb, ?::jsonb, ?, 'ACTIVE')
                """, tenantId, appId, releaseVersion, snapshotJson, changelogValue, operatorId);
    }

    @Override
    public List<Map<String, Object>> listReleases(long tenantId, long appId) {
        return jdbc.queryForList(
                "SELECT release_version, changelog::text AS changelog, operator_id, created_at, status "
                        + "FROM app_release WHERE tenant_id=? AND app_id=? ORDER BY release_version DESC",
                tenantId, appId);
    }

    @Override
    public Optional<Map<String, Object>> findRelease(long tenantId, long appId, int releaseVersion) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT snapshot::text AS snapshot, changelog::text AS changelog, status "
                        + "FROM app_release WHERE tenant_id=? AND app_id=? AND release_version=?",
                tenantId, appId, releaseVersion);
        return rows.stream().findFirst();
    }

    @Override
    public void markReleaseRolledBack(long tenantId, long appId, int releaseVersion) {
        jdbc.update("UPDATE app_release SET status='ROLLED_BACK' WHERE tenant_id=? AND app_id=? AND release_version=?",
                tenantId, appId, releaseVersion);
    }

    @SuppressWarnings("unused")
    private static Timestamp now() {
        return Timestamp.from(java.time.OffsetDateTime.now().toInstant());
    }
}
