package com.schema.data.domain.repository;

import java.util.List;
import java.util.Map;

/**
 * 元数据只读端口（01BE 边界：字段定义元数据归 metadata，data-engine 只消费）。
 * 模块化单体阶段由 bootstrap 组合根接线 metadata 应用服务；拆分后换 RPC。
 *
 * FieldMeta 是 data-engine 视角的字段投影（非聚合本体）：
 * - fieldStatus：读时兼容与 DELETED 强过滤的判定源（02BE §3.3 第 2 步）；
 * - promoteStatus='ACTIVE'：SQL 构建走提升列直查，否则 JSONB 表达式（§3.3 第 3 步）；
 * - validators/defaultValue：写入校验链消费（§3.4 create/update 第 1 步）。
 */
public interface MetadataPort {

    record FieldMeta(String fieldKey, String label, String fieldType, String fieldStatus,
            boolean required, boolean uniqueFlag, boolean indexed, String promoteStatus,
            Object defaultValue, List<Map<String, Object>> validators,
            Map<String, Object> relationConfig, Map<String, Object> computedConfig) {

        public boolean active() {
            return "ACTIVE".equals(fieldStatus);
        }

        public boolean promoted() {
            return indexed && "ACTIVE".equals(promoteStatus);
        }
    }

    record ModelMeta(long id, long tenantId, long appId, String modelKey, String name,
            String status, int currentVersion) {

        public boolean active() {
            return "ACTIVE".equals(status);
        }
    }

    /** 模型元数据（不存在/跨租户同判 Optional.empty——不给存在性线索）。 */
    java.util.Optional<ModelMeta> findModel(long tenantId, long modelId);

    /** 模型全部字段（含 DELETED——读时兼容判定需要；调用方按 fieldStatus 分流）。 */
    List<FieldMeta> findFields(long tenantId, long modelId);
}
