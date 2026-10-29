package com.schema.protocol.schema;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;

/** 校验协议导出使用的 JSON Schema 子集；未知关键字拒绝，避免静默漏校验。 */
public final class SchemaValidator {
    private SchemaValidator() { }

    public static boolean accepts(Map<String, Object> document, Object value) {
        return check(document, document, value, 0);
    }

    @SuppressWarnings("unchecked")
    private static boolean check(Map<String, Object> root, Map<String, Object> schema, Object value, int depth) {
        if (depth > 256) return false;
        for (String key : schema.keySet()) {
            if (!List.of("$ref", "$schema", "definitions", "type", "properties", "required", "additionalProperties",
                    "items", "anyOf", "allOf", "enum", "const", "minimum", "maximum", "minLength", "maxLength",
                    "minItems", "maxItems", "pattern", "description", "title", "default").contains(key)) {
                throw new IllegalArgumentException("Unsupported JSON Schema keyword: " + key);
            }
        }
        if (schema.containsKey("$ref")) {
            String ref = (String) schema.get("$ref");
            if (!ref.startsWith("#/")) throw new IllegalArgumentException("Only local references are supported");
            Object target = root;
            for (String part : ref.substring(2).split("/")) {
                String token = part.replace("~1", "/").replace("~0", "~");
                if (target instanceof Map<?, ?> map) target = map.get(token);
                else if (target instanceof List<?> list) target = list.get(Integer.parseInt(token));
                else throw new IllegalArgumentException("Unresolved reference: " + ref);
            }
            if (!(target instanceof Map)) throw new IllegalArgumentException("Unresolved reference: " + ref);
            return check(root, (Map<String, Object>) target, value, depth + 1);
        }
        if (schema.containsKey("anyOf")) {
            boolean match = false;
            for (Object branch : (List<?>) schema.get("anyOf")) {
                if (check(root, (Map<String, Object>) branch, value, depth + 1)) match = true;
            }
            if (!match) return false;
        }
        if (schema.containsKey("allOf")) {
            for (Object branch : (List<?>) schema.get("allOf")) {
                if (!check(root, (Map<String, Object>) branch, value, depth + 1)) return false;
            }
        }
        if (schema.containsKey("enum") && !((List<?>) schema.get("enum")).contains(value)) return false;
        if (schema.containsKey("const") && !Objects.equals(schema.get("const"), value)) return false;
        Object type = schema.get("type");
        if (type instanceof List<?> types) {
            boolean valid = false;
            for (Object candidate : types) {
                Map<String, Object> branch = new java.util.HashMap<>(schema);
                branch.put("type", candidate);
                if (check(root, branch, value, depth + 1)) valid = true;
            }
            return valid;
        }
        if (type != null) {
            boolean valid = switch (type.toString()) {
                case "null" -> value == null;
                case "string" -> value instanceof String;
                case "boolean" -> value instanceof Boolean;
                case "number" -> value instanceof Number n && Double.isFinite(n.doubleValue());
                case "integer" -> value instanceof Number n && Double.isFinite(n.doubleValue()) && n.doubleValue() == Math.rint(n.doubleValue());
                case "array" -> value instanceof List;
                case "object" -> value instanceof Map;
                default -> throw new IllegalArgumentException("Unsupported type: " + type);
            };
            if (!valid) return false;
        }
        if (value instanceof Number n) {
            if (schema.containsKey("minimum") && n.doubleValue() < ((Number) schema.get("minimum")).doubleValue()) return false;
            if (schema.containsKey("maximum") && n.doubleValue() > ((Number) schema.get("maximum")).doubleValue()) return false;
        }
        if (value instanceof String s) {
            if (schema.containsKey("minLength") && s.length() < ((Number) schema.get("minLength")).intValue()) return false;
            if (schema.containsKey("maxLength") && s.length() > ((Number) schema.get("maxLength")).intValue()) return false;
            if (schema.containsKey("pattern") && !Pattern.compile((String) schema.get("pattern")).matcher(s).find()) return false;
        }
        if (value instanceof List<?> list) {
            if (schema.containsKey("minItems") && list.size() < ((Number) schema.get("minItems")).intValue()) return false;
            if (schema.containsKey("maxItems") && list.size() > ((Number) schema.get("maxItems")).intValue()) return false;
            if (schema.get("items") instanceof Map<?, ?> items) {
                for (Object item : list) if (!check(root, (Map<String, Object>) items, item, depth + 1)) return false;
            }
        }
        if (value instanceof Map<?, ?> object) {
            for (Object key : (List<?>) schema.getOrDefault("required", List.of())) if (!object.containsKey(key)) return false;
            Map<String, Object> properties = (Map<String, Object>) schema.getOrDefault("properties", Map.of());
            for (var entry : object.entrySet()) {
                Object rule = properties.get(entry.getKey());
                if (rule == null) rule = schema.get("additionalProperties");
                if (Boolean.FALSE.equals(rule)) return false;
                if (rule instanceof Map<?, ?> map && !check(root, (Map<String, Object>) map, entry.getValue(), depth + 1)) return false;
            }
        }
        return true;
    }
}
