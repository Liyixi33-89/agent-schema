package com.schema.metadata.infrastructure.persistence;

import com.schema.metadata.domain.model.ModelAggregate;
import com.schema.metadata.domain.repository.ModelRepository;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.TimeZone;

/**
 * meta_model 仓储实现（JDBC）。
 * 租户隔离：所有查询显式带 tenant_id 谓词（持久层第一道防线；
 * 拦截器兜底随 M3 落地，当前 SQL 构建层显式注入先行——tenant-isolation-guard 双保险口径）。
 */
@Repository
public class JdbcModelRepository implements ModelRepository {

    private static final RowMapper<ModelAggregate> MAPPER = (rs, i) -> new ModelAggregate(
            rs.getLong("id"),
            rs.getLong("tenant_id"),
            rs.getLong("app_id"),
            rs.getString("model_key"),
            rs.getString("name"),
            rs.getString("icon"),
            rs.getString("status"),
            toOdt(rs.getTimestamp("deleted_at")),
            rs.getInt("current_version"));

    private static OffsetDateTime toOdt(Timestamp ts) {
        if (ts == null) {
            return null;
        }
        return ts.toInstant().atOffset(OffsetDateTime.now().getOffset());
    }

    private final JdbcTemplate jdbc;

    public JdbcModelRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public long insert(ModelAggregate m) {
        return jdbc.queryForObject("""
                INSERT INTO meta_model (tenant_id, app_id, model_key, name, icon, status, current_version, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
                """,
                Long.class,
                m.tenantId(), m.appId(), m.modelKey(), m.name(), m.icon(), m.status(),
                m.currentVersion(), 1L);
    }

    @Override
    public Optional<ModelAggregate> findById(long modelId) {
        List<ModelAggregate> result = jdbc.query(
                "SELECT * FROM meta_model WHERE id = ?", MAPPER, modelId);
        return result.stream().findFirst();
    }

    @Override
    public Optional<ModelAggregate> findByIdAndTenant(long modelId, long tenantId) {
        List<ModelAggregate> result = jdbc.query(
                "SELECT * FROM meta_model WHERE id = ? AND tenant_id = ?", MAPPER, modelId, tenantId);
        return result.stream().findFirst();
    }

    @Override
    public List<ModelAggregate> listByApp(long tenantId, long appId, String keyword, boolean includeDeleted) {
        StringBuilder sql = new StringBuilder("SELECT * FROM meta_model WHERE tenant_id = ? AND app_id = ?");
        java.util.List<Object> args = new java.util.ArrayList<>();
        args.add(tenantId);
        args.add(appId);
        if (!includeDeleted) {
            sql.append(" AND status = 'ACTIVE'");
        }
        if (keyword != null && !keyword.isBlank()) {
            sql.append(" AND (name ILIKE ? OR model_key ILIKE ?)");
            String like = "%" + keyword.trim() + "%";
            args.add(like);
            args.add(like);
        }
        sql.append(" ORDER BY id DESC");
        return jdbc.query(sql.toString(), MAPPER, args.toArray());
    }

    @Override
    public boolean advanceVersion(long modelId, long tenantId, int baseVersion) {
        return jdbc.update("""
                UPDATE meta_model SET current_version = ?, updated_at = now()
                WHERE id = ? AND tenant_id = ? AND current_version = ?
                """, baseVersion + 1, modelId, tenantId, baseVersion) == 1;
    }

    @Override
    public void updateProfile(long modelId, long tenantId, String name, String icon) {
        if (name != null && icon != null) {
            jdbc.update("UPDATE meta_model SET name=?, icon=?, updated_at=now() WHERE id=? AND tenant_id=?",
                    name, icon, modelId, tenantId);
        } else if (name != null) {
            jdbc.update("UPDATE meta_model SET name=?, updated_at=now() WHERE id=? AND tenant_id=?",
                    name, modelId, tenantId);
        } else if (icon != null) {
            jdbc.update("UPDATE meta_model SET icon=?, updated_at=now() WHERE id=? AND tenant_id=?",
                    icon, modelId, tenantId);
        }
    }

    @Override
    public void markDeleted(long modelId, long tenantId) {
        jdbc.update("UPDATE meta_model SET status='DELETED', deleted_at=now(), updated_at=now() WHERE id=? AND tenant_id=?",
                modelId, tenantId);
    }

    @Override
    public long countByTenant(long tenantId) {
        Long count = jdbc.queryForObject(
                "SELECT count(*) FROM meta_model WHERE tenant_id = ? AND status = 'ACTIVE'", Long.class, tenantId);
        return count != null ? count : 0;
    }

    @Override
    public boolean existsByModelKey(long tenantId, long appId, String modelKey) {
        Long count = jdbc.queryForObject(
                "SELECT count(*) FROM meta_model WHERE tenant_id=? AND app_id=? AND model_key=?",
                Long.class, tenantId, appId, modelKey);
        return count != null && count > 0;
    }

    @Override
    public boolean existsByIdAndTenant(long modelId, long tenantId) {
        Long count = jdbc.queryForObject(
                "SELECT count(*) FROM meta_model WHERE id=? AND tenant_id=?", Long.class, modelId, tenantId);
        return count != null && count > 0;
    }
}
