package com.schema.metadata.domain.model;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 变更操作（01BE §4.2 ChangeOp 联合体）：
 * ADD_FIELD / MODIFY_FIELD(patch 白名单) / DELETE_FIELD / PROMOTE_COLUMN。
 */
public sealed interface ChangeOp permits ChangeOp.AddField, ChangeOp.ModifyField, ChangeOp.DeleteField, ChangeOp.PromoteColumn {

    String op();

    String fieldKey();

    record AddField(String fieldKey, Map<String, Object> field) implements ChangeOp {
        public AddField {
            if (field == null) field = new LinkedHashMap<>();
        }

        @Override
        public String op() {
            return "ADD_FIELD";
        }

        public String label() {
            return str(field.get("label"));
        }

        public String fieldType() {
            return str(field.get("type"));
        }

        public boolean required() {
            return Boolean.TRUE.equals(field.get("required"));
        }

        public boolean uniqueFlag() {
            return Boolean.TRUE.equals(field.get("uniqueFlag"));
        }

        public boolean indexed() {
            return Boolean.TRUE.equals(field.get("indexed"));
        }

        public Object defaultValue() {
            return field.get("defaultValue");
        }

        @SuppressWarnings("unchecked")
        public List<Map<String, Object>> validators() {
            return (List<Map<String, Object>>) field.get("validators");
        }

        @SuppressWarnings("unchecked")
        public List<Map<String, Object>> enumOptions() {
            return (List<Map<String, Object>>) field.get("enumOptions");
        }

        @SuppressWarnings("unchecked")
        public Map<String, Object> relationConfig() {
            return (Map<String, Object>) field.get("relation");
        }

        @SuppressWarnings("unchecked")
        public Map<String, Object> computedConfig() {
            return (Map<String, Object>) field.get("computed");
        }

        public int sortOrder() {
            Object v = field.get("sortOrder");
            return v instanceof Number n ? n.intValue() : 0;
        }

        static String str(Object v) {
            return v instanceof String s ? s : null;
        }
    }

    /** MODIFY patch 白名单：label/required/uniqueFlag/indexed/defaultValue/validators/enumOptions/relation/computed/sortOrder。 */
    record ModifyField(String fieldKey, Map<String, Object> patch) implements ChangeOp {
        public ModifyField {
            if (patch == null) patch = new LinkedHashMap<>();
        }

        @Override
        public String op() {
            return "MODIFY_FIELD";
        }
    }

    record DeleteField(String fieldKey) implements ChangeOp {
        @Override
        public String op() {
            return "DELETE_FIELD";
        }
    }

    record PromoteColumn(String fieldKey) implements ChangeOp {
        @Override
        public String op() {
            return "PROMOTE_COLUMN";
        }
    }
}
