package com.schema.metadata.domain.repository;

import com.schema.metadata.domain.model.ModelAggregate;

import java.util.List;
import java.util.Map;

/**
 * 字段仓储接口（meta_field 行永不物理删除——01BE §3 铁律在实现层同样成立）。
 */
public interface FieldRepository {

    void insertField(long modelId, long tenantId, ModelAggregate.FieldDef field, int schemaVersion);

    /** 逻辑删除：field_status='DELETED' + deleted_at。 */
    void markDeleted(long modelId, long tenantId, String fieldKey, int schemaVersion);

    /** MODIFY 白名单更新（field_key/field_type 由聚合根保证不可改）。 */
    void updateField(long modelId, long tenantId, ModelAggregate.FieldDef field, int schemaVersion);

    /** 复活（回滚）：恢复 ACTIVE、清 deleted_at；promoteStatus 置草稿（不自动 promote）。 */
    void resurrectField(long modelId, long tenantId, ModelAggregate.FieldDef field, int schemaVersion);

    /** 按 schemaVersion 批量推进版本戳。 */
    void bumpSchemaVersion(long modelId, long tenantId, int schemaVersion);

    /** DB 侧字段当前是否 DELETED（回滚复活路径判定——内存聚合已被领域方法改写，不能作依据）。 */
    boolean existsActiveInDb(long modelId, String fieldKey);

    List<ModelAggregate.FieldDef> loadAll(long modelId);
}
