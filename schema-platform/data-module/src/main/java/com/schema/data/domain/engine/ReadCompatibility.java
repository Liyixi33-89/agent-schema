package com.schema.data.domain.engine;

import com.schema.data.domain.repository.MetadataPort.FieldMeta;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 读时兼容层（02BE §3.5）——「不做迁移」决策的运行时消费端。
 *
 * 职责：
 * 1. DELETED 字段强过滤：响应只保留 ACTIVE 字段键（不可见 ∪ 已删除一律剔除）；
 * 2. 类型容错：旧行数据按当前字段定义宽松解析，失败标记 _invalid:[fieldKey]（不抛错）；
 * 3. 缺键填充：新增字段的旧行无该键 → default 或 null；
 * 4. 版本比对短路：row.schema_version == currentVersion 时跳过兼容层直出（热路径零开销）。
 *
 * 只读转换，永不回写数据库。
 */
public final class ReadCompatibility {

    private ReadCompatibility() {
    }

    /**
     * 行兼容转换（02BE §3.5 readRow）。
     *
     * @param row            data JSONB 解析结果（已含 _id/_createdAt/_createdBy 平台键）
     * @param activeFields   ACTIVE 字段集（过滤与类型解析的判定源）
     * @param schemaVersion  行写入时版本
     * @param currentVersion 模型当前版本（相等时短路直出）
     */
    public static Map<String, Object> readRow(Map<String, Object> row,
            List<FieldMeta> activeFields, int schemaVersion, int currentVersion) {
        if (schemaVersion == currentVersion) {
            // 短路：同版本行跳过兼容层（热路径零开销）——但 DELETED 过滤仍需执行
            // （版本号相同不代表无 DELETED 字段——删除字段也推进版本，但并发窗口内可能同号）
            return filterDeleted(row, activeFields);
        }
        Map<String, Object> result = filterDeleted(row, activeFields);
        List<String> invalid = new ArrayList<>();
        for (FieldMeta f : activeFields) {
            Object raw = result.get(f.fieldKey());
            if (raw == null) {
                // 缺键填充：default 或 null（新增字段的旧行）
                if (f.defaultValue() != null) {
                    result.put(f.fieldKey(), f.defaultValue());
                }
                continue;
            }
            Object parsed = tryParse(raw, f);
            if (parsed == null) {
                invalid.add(f.fieldKey()); // 解析失败：保留原值 + 标记（前端展示 '--'）
            } else {
                result.put(f.fieldKey(), parsed);
            }
        }
        if (!invalid.isEmpty()) {
            result.put("_invalid", invalid);
        }
        return result;
    }

    /** DELETED 字段强过滤：不可见 ∪ 已删除一律物理剔除（03BE §3.4）。 */
    private static Map<String, Object> filterDeleted(Map<String, Object> row,
            List<FieldMeta> activeFields) {
        Map<String, Object> result = new LinkedHashMap<>();
        java.util.Set<String> activeKeys = new java.util.HashSet<>();
        for (FieldMeta f : activeFields) {
            activeKeys.add(f.fieldKey());
        }
        for (Map.Entry<String, Object> e : row.entrySet()) {
            // 平台键（_id/_createdAt 等 _ 前缀）与 ACTIVE 业务键保留；其余剔除
            if (e.getKey().startsWith("_") || activeKeys.contains(e.getKey())) {
                result.put(e.getKey(), e.getValue());
            }
        }
        return result;
    }

    /** 宽松解析：成功返回强类型值，失败返回 null 标记（不抛异常——02BE §3.5）。 */
    private static Object tryParse(Object raw, FieldMeta f) {
        try {
            return switch (f.fieldType()) {
                case "number", "computed" -> raw instanceof Number n ? n
                        : new java.math.BigDecimal(String.valueOf(raw));
                case "boolean" -> raw instanceof Boolean b ? b
                        : Boolean.parseBoolean(String.valueOf(raw));
                case "date" -> raw; // 时间戳/字符串双形态由前端按 schemaVersion 处理，不强转
                case "enum", "text", "richtext", "file", "relation", "geo", "user", "dept" -> raw;
                default -> raw;
            };
        } catch (Exception e) {
            return null;
        }
    }
}
