package com.schema.data.infrastructure.metadata;

import com.schema.data.domain.repository.MetadataPort;
import com.schema.metadata.application.MetadataCommandService;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 元数据端口适配器：进程内直连 metadata 应用服务（单体阶段；拆分后换 RPC 实现）。
 *
 * getModel 返回 fieldView 列表（含 fieldStatus/promoteStatus）——数据引擎消费的字段投影
 * 与前端 getModel 响应同构（协议面一致：双端同判不漂移）。
 */
@Component
public class MetadataPortAdapter implements MetadataPort {

    private final MetadataCommandService metadata;

    public MetadataPortAdapter(MetadataCommandService metadata) {
        this.metadata = metadata;
    }

    @Override
    @SuppressWarnings("unchecked")
    public Optional<ModelMeta> findModel(long tenantId, long modelId) {
        // TenantContext 由调用方设定；跨租户在 metadata.loadForTenant 内同判不存在
        try {
            Map<String, Object> model = metadata.getModel(modelId);
            return Optional.of(new ModelMeta(
                    Long.parseLong((String) model.get("id")),
                    tenantId,
                    asLong(model.get("appId")),
                    (String) model.get("modelKey"),
                    (String) model.get("name"),
                    (String) model.get("status"),
                    ((Number) model.get("currentVersion")).intValue()));
        } catch (com.schema.platform.common.web.BizException e) {
            return Optional.empty(); // 不存在/跨租户同判
        }
    }

    @Override
    @SuppressWarnings("unchecked")
    public List<FieldMeta> findFields(long tenantId, long modelId) {
        Map<String, Object> model = metadata.getModel(modelId);
        List<FieldMeta> fields = new ArrayList<>();
        Object raw = model.get("fields");
        if (raw instanceof List<?> list) {
            for (Object item : list) {
                if (item instanceof Map<?, ?> m) {
                    Map<String, Object> f = (Map<String, Object>) m;
                    fields.add(new FieldMeta(
                            (String) f.get("fieldKey"),
                            (String) f.get("label"),
                            (String) f.get("type"),
                            (String) f.get("fieldStatus"),
                            Boolean.TRUE.equals(f.get("required")),
                            Boolean.TRUE.equals(f.get("uniqueFlag")),
                            Boolean.TRUE.equals(f.get("indexed")),
                            (String) f.get("promoteStatus"),
                            f.get("defaultValue"),
                            (List<Map<String, Object>>) f.get("validators"),
                            (List<Map<String, Object>>) f.get("enumOptions"),
                            (Map<String, Object>) f.get("relation"),
                            (Map<String, Object>) f.get("computed")));
                }
            }
        }
        return fields;
    }

    private static long asLong(Object v) {
        if (v instanceof Number n) {
            return n.longValue();
        }
        return v == null ? 0 : Long.parseLong(String.valueOf(v));
    }
}
