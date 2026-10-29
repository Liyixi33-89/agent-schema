package com.schema.metadata.infrastructure.persistence;

import com.schema.metadata.domain.model.ModelAggregate;
import com.schema.metadata.domain.repository.FieldRepository;
import com.schema.platform.common.json.Json;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.sql.Timestamp;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

/**
 * meta_field 仓储实现（JDBC）。
 * 铁律落地：任何方法都不出现 DELETE FROM meta_field（01BE §3——行永不物理删除）。
 */
@Repository
public class JdbcFieldRepository implements FieldRepository {

    private static final RowMapper<ModelAggregate.FieldDef> MAPPER = (rs, i) -> new ModelAggregate.FieldDef(
            rs.getLong("id"),
            rs.getString("field_key"),
            rs.getString("label"),
            rs.getString("field_type"),
            rs.getString("field_status"),
            toOdt(rs.getTimestamp("deleted_at")),
            rs.getBoolean("required"),
            rs.getBoolean("unique_flag"),
            rs.getBoolean("indexed"),
            rs.getString("promote_status"),
            Json.readMap(rs.getString("default_value")),
            readList(rs.getString("validators")),
            readList(rs.getString("enum_options")),
            Json.readMap(rs.getString("relation_config")),
            Json.readMap(rs.getString("computed_config")),
            rs.getInt("sort_order"),
            rs.getInt("schema_version"));

    private static OffsetDateTime toOdt(Timestamp ts) {
        return ts != null ? ts.toInstant().atOffset(OffsetDateTime.now().getOffset()) : null;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> readList(String json) {
        if (json == null || json.isBlank() || "null".equals(json)) {
            return null;
        }
        Object parsed = Json.parse(json);
        if (!(parsed instanceof List<?> list)) {
            throw new IllegalArgumentException("JSON 数组格式非法");
        }
        return (List<Map<String, Object>>) list;
    }

    private static String writeList(List<Map<String, Object>> list) {
        return list == null ? null : Json.write(list);
    }

    private final JdbcTemplate jdbc;

    public JdbcFieldRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void insertField(long modelId, long tenantId, ModelAggregate.FieldDef f, int schemaVersion) {
        jdbc.update("""
                INSERT INTO meta_field (tenant_id, model_id, field_key, label, field_type, field_status,
                  required, unique_flag, indexed, promote_status, default_value, validators, enum_options,
                  relation_config, computed_config, sort_order, schema_version)
                VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, ?, ?)
                """,
                tenantId, modelId, f.fieldKey(), f.label(), f.fieldType(),
                f.required(), f.uniqueFlag(), f.indexed(), f.promoteStatus(),
                f.defaultValue() == null ? null : Json.write(f.defaultValue()),
                writeList(f.validators()), writeList(f.enumOptions()),
                f.relationConfig() == null ? null : Json.write(f.relationConfig()),
                f.computedConfig() == null ? null : Json.write(f.computedConfig()),
                f.sortOrder(), schemaVersion);
    }

    @Override
    public void markDeleted(long modelId, long tenantId, String fieldKey, int schemaVersion) {
        jdbc.update("""
                UPDATE meta_field SET field_status='DELETED', deleted_at=now(), schema_version=?, updated_at=now()
                WHERE model_id=? AND tenant_id=? AND field_key=?
                """, schemaVersion, modelId, tenantId, fieldKey);
    }

    @Override
    public void updateField(long modelId, long tenantId, ModelAggregate.FieldDef f, int schemaVersion) {
        jdbc.update("""
                UPDATE meta_field SET label=?, required=?, unique_flag=?, indexed=?, promote_status=?,
                  default_value=?::jsonb, validators=?::jsonb, enum_options=?::jsonb,
                  relation_config=?::jsonb, computed_config=?::jsonb, sort_order=?, schema_version=?, updated_at=now()
                WHERE model_id=? AND tenant_id=? AND field_key=?
                """,
                f.label(), f.required(), f.uniqueFlag(), f.indexed(), f.promoteStatus(),
                f.defaultValue() == null ? null : Json.write(f.defaultValue()),
                writeList(f.validators()), writeList(f.enumOptions()),
                f.relationConfig() == null ? null : Json.write(f.relationConfig()),
                f.computedConfig() == null ? null : Json.write(f.computedConfig()),
                f.sortOrder(), schemaVersion, modelId, tenantId, f.fieldKey());
    }

    @Override
    public void resurrectField(long modelId, long tenantId, ModelAggregate.FieldDef f, int schemaVersion) {
        jdbc.update("""
                UPDATE meta_field SET field_status='ACTIVE', deleted_at=NULL, promote_status=NULL,
                  schema_version=?, updated_at=now()
                WHERE model_id=? AND tenant_id=? AND field_key=?
                """, schemaVersion, modelId, tenantId, f.fieldKey());
    }

    @Override
    public void bumpSchemaVersion(long modelId, long tenantId, int schemaVersion) {
        jdbc.update("UPDATE meta_field SET schema_version=? WHERE model_id=? AND tenant_id=?",
                schemaVersion, modelId, tenantId);
    }

    @Override
    public List<ModelAggregate.FieldDef> loadAll(long modelId) {
        return jdbc.query("SELECT * FROM meta_field WHERE model_id=? ORDER BY sort_order, id", MAPPER, modelId);
    }

    @Override
    public boolean existsActiveInDb(long modelId, String fieldKey) {
        Long count = jdbc.queryForObject(
                "SELECT count(*) FROM meta_field WHERE model_id=? AND field_key=? AND field_status='DELETED'",
                Long.class, modelId, fieldKey);
        return count != null && count > 0;
    }
}
