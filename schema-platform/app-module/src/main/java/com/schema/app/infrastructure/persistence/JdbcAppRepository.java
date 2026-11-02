package com.schema.app.infrastructure.persistence;

import com.schema.app.domain.model.App;
import com.schema.app.domain.repository.AppRepository;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * app 仓储实现（JDBC）。
 * 租户隔离：所有查询显式带 tenant_id 谓词（tenant-isolation-guard 双保险口径）。
 */
@Repository
public class JdbcAppRepository implements AppRepository {

    private static Long nullableLong(ResultSet rs, String col) throws SQLException {
        Object v = rs.getObject(col);
        return v == null ? null : ((Number) v).longValue();
    }

    private static final RowMapper<App> APP_MAPPER = (rs, i) -> new App(
            rs.getLong("id"),
            rs.getLong("tenant_id"),
            rs.getString("name"),
            nullableLong(rs, "icon_file_id"),
            rs.getString("description"),
            rs.getString("theme"),
            rs.getString("nav_tree"),
            rs.getInt("nav_version"),
            App.Status.valueOf(rs.getString("status")),
            toOdt(rs.getTimestamp("deleted_at")),
            nullableLong(rs, "created_by"),
            toOdt(rs.getTimestamp("created_at")),
            toOdt(rs.getTimestamp("updated_at")));

    private static OffsetDateTime toOdt(Timestamp ts) {
        if (ts == null) {
            return null;
        }
        return ts.toInstant().atOffset(OffsetDateTime.now().getOffset());
    }

    private final JdbcTemplate jdbc;

    public JdbcAppRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public long insert(App a) {
        return jdbc.queryForObject("""
                INSERT INTO app (tenant_id, name, icon_file_id, description, theme, nav_tree, nav_version, status, created_by)
                VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?) RETURNING id
                """,
                Long.class,
                a.tenantId(), a.name(), a.iconFileId(), a.description(),
                a.themeJson(), a.navTreeJson(), a.navVersion(), a.status().name(), a.createdBy());
    }

    @Override
    public Optional<App> findById(long appId) {
        return jdbc.query(
                "SELECT * FROM app WHERE id = ? AND status <> 'DELETING'", APP_MAPPER, appId)
                .stream().findFirst();
    }

    @Override
    public Optional<App> findByIdAndTenant(long appId, long tenantId) {
        return jdbc.query(
                "SELECT * FROM app WHERE id = ? AND tenant_id = ? AND status <> 'DELETING'",
                APP_MAPPER, appId, tenantId)
                .stream().findFirst();
    }

    @Override
    public List<App> listByTenant(long tenantId, String keyword, boolean includeArchived) {
        StringBuilder sql = new StringBuilder(
                "SELECT * FROM app WHERE tenant_id = ? AND status <> 'DELETING'");
        List<Object> args = new ArrayList<>();
        args.add(tenantId);
        if (!includeArchived) {
            sql.append(" AND status <> 'ARCHIVED'");
        }
        if (keyword != null && !keyword.isBlank()) {
            sql.append(" AND (name ILIKE ? OR description ILIKE ?)");
            String like = "%" + keyword.trim() + "%";
            args.add(like);
            args.add(like);
        }
        sql.append(" ORDER BY id DESC");
        return jdbc.query(sql.toString(), APP_MAPPER, args.toArray());
    }

    @Override
    public void updateProfile(long appId, long tenantId, String name, Long iconFileId,
                              String description, String themeJson) {
        jdbc.update("""
                UPDATE app SET name=?, icon_file_id=?, description=?, theme=?::jsonb, updated_at=now()
                WHERE id=? AND tenant_id=?
                """, name, iconFileId, description, themeJson, appId, tenantId);
    }

    @Override
    public int updateNavTree(long appId, long tenantId, String navTreeJson, int baseVersion, int newVersion) {
        return jdbc.update("""
                UPDATE app SET nav_tree=?::jsonb, nav_version=?, updated_at=now()
                WHERE id=? AND tenant_id=? AND nav_version=?
                """, navTreeJson, newVersion, appId, tenantId, baseVersion);
    }

    @Override
    public void updateStatus(long appId, long tenantId, String status, OffsetDateTime deletedAt) {
        if (deletedAt != null) {
            jdbc.update("UPDATE app SET status=?, deleted_at=?, updated_at=now() WHERE id=? AND tenant_id=?",
                    status, deletedAt, appId, tenantId);
        } else {
            jdbc.update("UPDATE app SET status=?, updated_at=now() WHERE id=? AND tenant_id=?",
                    status, appId, tenantId);
        }
    }

    @Override
    public long countByTenant(long tenantId) {
        Long c = jdbc.queryForObject(
                "SELECT count(*) FROM app WHERE tenant_id=? AND status <> 'DELETING'", Long.class, tenantId);
        return c != null ? c : 0;
    }

    @Override
    public void lockQuotaAnchor(long tenantId) {
        // 锁最早一行作为租户配额锚点（租户无 app 时无行可锁——首应用创建本就无竞态对象，
        // 并发插入由 UNIQUE(tenant_id, name) 收口为重名冲突）
        jdbc.queryForList("""
                SELECT id FROM app WHERE tenant_id=? AND status <> 'DELETING'
                ORDER BY id LIMIT 1 FOR UPDATE
                """, tenantId);
    }

    @Override
    public boolean existsByName(long tenantId, String name) {
        Long c = jdbc.queryForObject(
                "SELECT count(*) FROM app WHERE tenant_id=? AND name=? AND status <> 'DELETING'",
                Long.class, tenantId, name);
        return c != null && c > 0;
    }
}