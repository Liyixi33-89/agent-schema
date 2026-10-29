package com.schema.metadata.domain.model;

import com.schema.platform.common.tenant.TenantInfo;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 模型聚合根（01BE §2/§3）：字段状态机与不变式唯一收口处。
 * 铁律：meta_field 行永不物理删除；删除字段 = field_status 置 DELETED + deleted_at。
 */
public class ModelAggregate {

    private Long id;
    private long tenantId;
    private long appId;
    private String modelKey;
    private String name;
    private String icon;
    private String status;           // ACTIVE / DELETED / ARCHIVED
    private OffsetDateTime deletedAt;
    private int currentVersion;
    private final Map<String, FieldDef> fieldsByKey = new LinkedHashMap<>();

    public static final String STATUS_ACTIVE = "ACTIVE";
    public static final String STATUS_DELETED = "DELETED";

    /** 字段定义（聚合内实体）：类型创建后冻结（field_key/field_type 不可改，01BE §4.2 MODIFY 白名单）。 */
    public static final class FieldDef {
        private Long id;
        private final String fieldKey;
        private String label;
        private final String fieldType;
        private String fieldStatus;   // ACTIVE / DELETED
        private OffsetDateTime deletedAt;
        private boolean required;
        private boolean uniqueFlag;
        private boolean indexed;
        private String promoteStatus; // null / PENDING / BUILDING / ACTIVE / FAILED
        private Object defaultValue;
        private List<Map<String, Object>> validators;
        private List<Map<String, Object>> enumOptions;
        private Map<String, Object> relationConfig;
        private Map<String, Object> computedConfig;
        private int sortOrder;
        private int schemaVersion;

        public FieldDef(Long id, String fieldKey, String label, String fieldType, String fieldStatus,
                OffsetDateTime deletedAt, boolean required, boolean uniqueFlag, boolean indexed,
                String promoteStatus, Object defaultValue, List<Map<String, Object>> validators,
                List<Map<String, Object>> enumOptions, Map<String, Object> relationConfig,
                Map<String, Object> computedConfig, int sortOrder, int schemaVersion) {
            this.id = id;
            this.fieldKey = fieldKey;
            this.label = label;
            this.fieldType = fieldType;
            this.fieldStatus = fieldStatus;
            this.deletedAt = deletedAt;
            this.required = required;
            this.uniqueFlag = uniqueFlag;
            this.indexed = indexed;
            this.promoteStatus = promoteStatus;
            this.defaultValue = defaultValue;
            this.validators = validators;
            this.enumOptions = enumOptions;
            this.relationConfig = relationConfig;
            this.computedConfig = computedConfig;
            this.sortOrder = sortOrder;
            this.schemaVersion = schemaVersion;
        }

        public String fieldKey() {
            return fieldKey;
        }

        public String label() {
            return label;
        }

        public String fieldType() {
            return fieldType;
        }

        public String fieldStatus() {
            return fieldStatus;
        }

        public boolean isActive() {
            return STATUS_ACTIVE.equals(fieldStatus);
        }

        public boolean deleted() {
            return STATUS_DELETED.equals(fieldStatus);
        }

        public boolean indexed() {
            return indexed;
        }

        public String promoteStatus() {
            return promoteStatus;
        }

        public Object defaultValue() {
            return defaultValue;
        }

        public List<Map<String, Object>> validators() {
            return validators;
        }

        public List<Map<String, Object>> enumOptions() {
            return enumOptions;
        }

        public Map<String, Object> relationConfig() {
            return relationConfig;
        }

        public Map<String, Object> computedConfig() {
            return computedConfig;
        }

        public int sortOrder() {
            return sortOrder;
        }

        public int schemaVersion() {
            return schemaVersion;
        }

        public Long id() {
            return id;
        }

        public boolean required() {
            return required;
        }

        public boolean uniqueFlag() {
            return uniqueFlag;
        }

        public OffsetDateTime deletedAt() {
            return deletedAt;
        }

        /** 字段类型合法性：12 种协议 code（与 FieldType 枚举一致）。 */
        public static boolean validType(String type) {
            return type != null && java.util.Set.of("text", "number", "date", "enum", "boolean", "file",
                    "richtext", "relation", "geo", "user", "dept", "computed").contains(type);
        }
    }

    public ModelAggregate(Long id, long tenantId, long appId, String modelKey, String name, String icon,
            String status, OffsetDateTime deletedAt, int currentVersion) {
        this.id = id;
        this.tenantId = tenantId;
        this.appId = appId;
        this.modelKey = modelKey;
        this.name = name;
        this.icon = icon;
        this.status = status;
        this.deletedAt = deletedAt;
        this.currentVersion = currentVersion;
    }

    public static ModelAggregate create(TenantInfo tenant, String modelKey, String name, String icon) {
        if (modelKey == null || !modelKey.matches("[a-z][a-z0-9_]{0,63}")) {
            throw new IllegalArgumentException("modelKey 必须为小写字母开头的标识（a-z0-9_，≤64 字符）");
        }
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("name 不能为空");
        }
        return new ModelAggregate(null, tenant.tenantId(), tenant.appId(), modelKey, name.trim(), icon,
                STATUS_ACTIVE, null, 1);
    }

    public void addField(FieldDef field) {
        if (!FieldDef.validType(field.fieldType)) {
            throw new IllegalArgumentException("非法字段类型: " + field.fieldType);
        }
        if (fieldsByKey.containsKey(field.fieldKey)) {
            throw new IllegalArgumentException("字段已存在: " + field.fieldKey);
        }
        fieldsByKey.put(field.fieldKey, field);
    }

    public void loadField(FieldDef field) {
        fieldsByKey.put(field.fieldKey, field);
    }

    public Optional<FieldDef> findField(String fieldKey) {
        return Optional.ofNullable(fieldsByKey.get(fieldKey));
    }

    public List<FieldDef> activeFields() {
        List<FieldDef> result = new ArrayList<>();
        for (FieldDef f : fieldsByKey.values()) {
            if (f.isActive()) {
                result.add(f);
            }
        }
        result.sort(java.util.Comparator.comparingInt(FieldDef::sortOrder));
        return result;
    }

    public List<FieldDef> allFields() {
        return new ArrayList<>(fieldsByKey.values());
    }

    /**
     * 删除字段（状态机迁移，01BE §3）：只置 DELETED + deleted_at，永不物理删除行；
     * 已删除提升列不执行 DROP COLUMN——仅元数据停止引用。
     */
    public void deleteField(String fieldKey, OffsetDateTime now) {
        FieldDef field = requireField(fieldKey);
        if (field.deleted()) {
            return; // 幂等
        }
        field.fieldStatus = STATUS_DELETED;
        field.deletedAt = now;
    }

    /** 回滚复活（01BE §4.3）：恢复为 ACTIVE 草稿态，不自动 promote 列。 */
    public void resurrectField(String fieldKey, OffsetDateTime now) {
        FieldDef field = requireField(fieldKey);
        if (field.isActive()) {
            return;
        }
        field.fieldStatus = STATUS_ACTIVE;
        field.deletedAt = null;
        // 不自动 promote：promoteStatus 维持原值或清为待人工触发
    }

    /** 字段复活场景（回滚到含 DELETED 字段的版本）：以草稿态带回集合。 */
    public void resurrectFieldDraft(String fieldKey, String label, String fieldType, boolean required,
            boolean uniqueFlag, boolean indexed, Object defaultValue, List<Map<String, Object>> validators,
            List<Map<String, Object>> enumOptions, Map<String, Object> relationConfig,
            Map<String, Object> computedConfig, int sortOrder, int schemaVersion) {
        FieldDef existing = fieldsByKey.get(fieldKey);
        if (existing != null && existing.isActive()) {
            return; // 已存在且存活，无需复活
        }
        if (existing != null) {
            existing.fieldStatus = STATUS_ACTIVE;
            existing.deletedAt = null;
            existing.label = label;
            existing.required = required;
            existing.uniqueFlag = uniqueFlag;
            existing.indexed = indexed;
            existing.defaultValue = defaultValue;
            existing.validators = validators;
            existing.enumOptions = enumOptions;
            existing.relationConfig = relationConfig;
            existing.computedConfig = computedConfig;
            existing.sortOrder = sortOrder;
            existing.schemaVersion = schemaVersion;
            existing.promoteStatus = null; // 草稿态：不自动 promote
            return;
        }
        addField(new FieldDef(null, fieldKey, label, fieldType, STATUS_ACTIVE, null, required, uniqueFlag,
                indexed, null, defaultValue, validators, enumOptions, relationConfig, computedConfig,
                sortOrder, schemaVersion));
    }

    /** MODIFY 白名单更新（01BE §4.2）：field_key/field_type 不可改，由调用方先行拦截。 */
    public void modifyField(String fieldKey, String label, Boolean required, Boolean uniqueFlag,
            Boolean indexed, Object defaultValue, List<Map<String, Object>> validators,
            List<Map<String, Object>> enumOptions, Map<String, Object> relationConfig,
            Map<String, Object> computedConfig, Integer sortOrder, int targetSchemaVersion) {
        FieldDef field = requireField(fieldKey);
        if (label != null) field.label = label;
        if (required != null) field.required = required;
        if (uniqueFlag != null) field.uniqueFlag = uniqueFlag;
        if (indexed != null && indexed && !field.indexed) {
            // 新标记提升列：进入 PENDING 等待 DDL 任务（01BE §4.2 步骤 3）
            field.indexed = true;
            if (field.promoteStatus == null) {
                field.promoteStatus = "PENDING";
            }
        }
        if (defaultValue != null) field.defaultValue = defaultValue;
        if (validators != null) field.validators = validators;
        if (enumOptions != null) field.enumOptions = enumOptions;
        if (relationConfig != null) field.relationConfig = relationConfig;
        if (computedConfig != null) field.computedConfig = computedConfig;
        if (sortOrder != null) field.sortOrder = sortOrder;
        field.schemaVersion = targetSchemaVersion;
    }

    /** 新增字段：indexed=true 时 promote_status='PENDING'（01BE §4.2）。 */
    public void addNewField(String fieldKey, String label, String fieldType, boolean required,
            boolean uniqueFlag, boolean indexed, Object defaultValue, List<Map<String, Object>> validators,
            List<Map<String, Object>> enumOptions, Map<String, Object> relationConfig,
            Map<String, Object> computedConfig, int sortOrder, int targetSchemaVersion) {
        if (!FieldDef.validType(fieldType)) {
            throw new IllegalArgumentException("非法字段类型: " + fieldType);
        }
        if (fieldsByKey.containsKey(fieldKey)) {
            throw new IllegalArgumentException("字段已存在: " + fieldKey);
        }
        addField(new FieldDef(null, fieldKey, label, fieldType, STATUS_ACTIVE, null, required, uniqueFlag,
                indexed, indexed ? "PENDING" : null, defaultValue, validators, enumOptions,
                relationConfig, computedConfig, sortOrder, targetSchemaVersion));
    }

    /** 校验计算字段依赖不成环（01BE §4.2 步骤 4）；返回环路径（空 = 无环）。 */
    public List<String> detectCircularDependency() {
        Map<String, List<String>> graph = new LinkedHashMap<>();
        for (FieldDef f : activeFields()) {
            if (f.computedConfig != null && f.computedConfig.get("dependsOn") instanceof List<?> deps) {
                List<String> edges = new ArrayList<>();
                for (Object d : deps) {
                    if (d instanceof String s && fieldsByKey.containsKey(s)) {
                        edges.add(s);
                    }
                }
                graph.put(f.fieldKey, edges);
            }
        }
        java.util.Set<String> visiting = new java.util.HashSet<>();
        java.util.Set<String> done = new java.util.HashSet<>();
        for (String start : graph.keySet()) {
            List<String> cycle = dfs(start, graph, visiting, done);
            if (cycle != null) {
                return cycle;
            }
        }
        return List.of();
    }

    private static List<String> dfs(String node, Map<String, List<String>> graph,
            java.util.Set<String> visiting, java.util.Set<String> done) {
        if (done.contains(node)) {
            return null;
        }
        if (!visiting.add(node)) {
            return null; // 不该发生（调用方逐一起点），防御返回
        }
        for (String next : graph.getOrDefault(node, List.of())) {
            if (visiting.contains(next)) {
                // 发现环：next → ... → node → next
                List<String> cycle = new ArrayList<>();
                cycle.add(next);
                cycle.add(node);
                return cycle;
            }
            List<String> cycle = dfs(next, graph, visiting, done);
            if (cycle != null) {
                cycle.add(0, node);
                return cycle;
            }
        }
        visiting.remove(node);
        done.add(node);
        return null;
    }

    private FieldDef requireField(String fieldKey) {
        FieldDef field = fieldsByKey.get(fieldKey);
        if (field == null) {
            throw new IllegalArgumentException("字段不存在: " + fieldKey);
        }
        return field;
    }

    public boolean deletedModel() {
        return STATUS_DELETED.equals(status);
    }

    public Long id() {
        return id;
    }

    public void assignId(long id) {
        this.id = id;
    }

    public long tenantId() {
        return tenantId;
    }

    public long appId() {
        return appId;
    }

    public String modelKey() {
        return modelKey;
    }

    public String name() {
        return name;
    }

    public void rename(String name) {
        if (name != null && !name.isBlank()) {
            this.name = name.trim();
        }
    }

    public void changeIcon(String icon) {
        if (icon != null) {
            this.icon = icon;
        }
    }

    public String status() {
        return status;
    }

    public int currentVersion() {
        return currentVersion;
    }

    /** 乐观锁推进（01BE §4.2 步骤 1）：仅当传入 base 与当前一致才允许推进版本。 */
    public void advanceVersion(int baseVersion) {
        if (this.currentVersion != baseVersion) {
            throw new IllegalStateException("VERSION_MISMATCH:" + this.currentVersion);
        }
        this.currentVersion = baseVersion + 1;
    }

    public void setCurrentVersion(int version) {
        this.currentVersion = version;
    }

    public OffsetDateTime deletedAt() {
        return deletedAt;
    }

    public String icon() {
        return icon;
    }
}
