package com.schema.metadata.infrastructure.persistence;

import com.schema.metadata.domain.repository.SchemaVersionRepository;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * meta_schema_version / meta_confirm_token / meta_field_reference 仓储实现。
 * confirmToken 一次性消费：UPDATE ... WHERE consumed_at IS NULL 的 CAS 语义（事务纪律选型表）。
 */
@Repository
public class JdbcSchemaVersionRepository implements SchemaVersionRepository {

    private static final RowMapper<VersionSnapshot> MAPPER = (rs, i) -> new VersionSnapshot(
            rs.getLong("model_id"), rs.getInt("version"), rs.getString("snapshot"),
            rs.getString("diff"), rs.getLong("operator_id"),
            toOdt(rs.getTimestamp("created_at")),
            rs.getObject("rollback_from") instanceof Number n ? n.intValue() : null);

    private static OffsetDateTime toOdt(Timestamp ts) {
        return ts != null ? ts.toInstant().atOffset(OffsetDateTime.now().getOffset()) : null;
    }

    private final JdbcTemplate jdbc;

    public JdbcSchemaVersionRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void insertSnapshot(VersionSnapshot s) {
        jdbc.update("""
                INSERT INTO meta_schema_version (model_id, version, snapshot, diff, operator_id, rollback_from)
                VALUES (?, ?, ?::jsonb, ?::jsonb, ?, ?)
                """, s.modelId(), s.version(), s.snapshotJson(), s.diffJson(), s.operatorId(), s.rollbackFrom());
    }

    @Override
    public List<VersionSnapshot> listVersions(long modelId, int limit) {
        return jdbc.query("SELECT * FROM meta_schema_version WHERE model_id=? ORDER BY version DESC LIMIT ?",
                MAPPER, modelId, limit);
    }

    @Override
    public Optional<VersionSnapshot> findVersion(long modelId, int version) {
        List<VersionSnapshot> result = jdbc.query(
                "SELECT * FROM meta_schema_version WHERE model_id=? AND version=?", MAPPER, modelId, version);
        return result.stream().findFirst();
    }

    @Override
    public void issueToken(String token, long modelId, String bindingHash, int baseVersion,
            String confirmMode, OffsetDateTime expiresAt) {
        jdbc.update("""
                INSERT INTO meta_confirm_token (token, model_id, binding_hash, base_version, confirm_mode, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """, token, modelId, bindingHash, baseVersion, confirmMode, Timestamp.from(expiresAt.toInstant()));
    }

    @Override
    public boolean consumeToken(String token, long modelId, String bindingHash, int baseVersion) {
        // 五元组校验：token 有效 + modelId 一致 + binding hash 一致 + baseVersion 一致
        // + 未消费未过期（01BE §4.2）；校验失败不消费（可修正后重试直至过期）
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT model_id, binding_hash, base_version, expires_at, consumed_at "
                        + "FROM meta_confirm_token WHERE token=?",
                token);
        if (rows.size() != 1) {
            return false;
        }
        Map<String, Object> row = rows.get(0);
        if (row.get("consumed_at") != null) {
            return false;
        }
        if (((Number) row.get("model_id")).longValue() != modelId) {
            return false;
        }
        if (!java.util.Objects.equals(row.get("binding_hash"), bindingHash)) {
            return false;
        }
        if (((Number) row.get("base_version")).intValue() != baseVersion) {
            return false;
        }
        OffsetDateTime expires = toOdt((Timestamp) row.get("expires_at"));
        if (expires == null || expires.isBefore(OffsetDateTime.now())) {
            return false;
        }
        return jdbc.update("UPDATE meta_confirm_token SET consumed_at=now() WHERE token=? AND consumed_at IS NULL",
                token) == 1;
    }

    @Override
    public java.util.Optional<String> findTokenMode(String token) {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT confirm_mode, expires_at FROM meta_confirm_token WHERE token=? AND consumed_at IS NULL", token);
        if (rows.size() != 1) {
            return java.util.Optional.empty();
        }
        OffsetDateTime expires = toOdt((Timestamp) rows.get(0).get("expires_at"));
        if (expires == null || expires.isBefore(OffsetDateTime.now())) {
            return java.util.Optional.empty();
        }
        return java.util.Optional.of((String) rows.get(0).get("confirm_mode"));
    }

    @Override
    public void purgeExpiredTokens() {
        jdbc.update("DELETE FROM meta_confirm_token WHERE expires_at < now() - interval '1 day'");
    }

    @Override
    public void upsertReference(long tenantId, long modelId, String fieldKey, String refType, long refId) {
        jdbc.update("""
                INSERT INTO meta_field_reference (tenant_id, model_id, field_key, ref_type, ref_id)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (model_id, field_key, ref_type, ref_id) DO NOTHING
                """, tenantId, modelId, fieldKey, refType, refId);
    }

    @Override
    public List<Map<String, Object>> findReferences(long tenantId, long modelId, List<String> fieldKeys) {
        if (fieldKeys.isEmpty()) {
            return List.of();
        }
        String placeholders = String.join(",", java.util.Collections.nCopies(fieldKeys.size(), "?"));
        List<Object> args = new ArrayList<>();
        args.add(modelId);
        args.addAll(fieldKeys);
        return jdbc.queryForList(
                "SELECT DISTINCT field_key, ref_type, ref_id FROM meta_field_reference "
                        + "WHERE model_id=? AND field_key IN (" + placeholders + ")",
                args.toArray());
    }

    @Override
    public void upsertComputedReferences(long tenantId, long modelId, String computedFieldKey,
            List<String> dependsOn) {
        if (dependsOn == null) {
            return;
        }
        for (String dep : dependsOn) {
            // COMPUTED 引用：ref_id = 计算字段自身 meta_field.id（口径：被依赖字段 ← 计算字段）
            jdbc.update("""
                    INSERT INTO meta_field_reference (tenant_id, model_id, field_key, ref_type, ref_id)
                    SELECT ?, ?, ?, 'COMPUTED', mf.id FROM meta_field mf
                      WHERE mf.model_id=? AND mf.field_key=?
                    ON CONFLICT (model_id, field_key, ref_type, ref_id) DO NOTHING
                    """, tenantId, modelId, dep, modelId, computedFieldKey);
        }
    }

    @Override
    public void deleteAllComputedReferences(long modelId) {
        jdbc.update("DELETE FROM meta_field_reference WHERE model_id=? AND ref_type='COMPUTED'", modelId);
    }
}
