package com.schema.data.domain.engine;

import com.schema.data.domain.repository.MetadataPort.FieldMeta;
import com.schema.platform.common.web.BizException;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * 写入校验链（02BE §3.4 第 1 步）：required → 类型 → validators(range/regex/expression)
 * → 枚举值域 → relation 目标存在性（由引擎侧批量查表回调）。
 *
 * 与前端表单校验管线（03FE §4）同构：双端同判，服务端为安全边界。
 * 校验失败聚合为单次 VALIDATION_FAILED（附 {fieldKey: message} 表——02BE §A.6）。
 */
public final class WriteValidator {

    private WriteValidator() {
    }

    /** relation 目标存在性回调（引擎注入：批量查目标表防 N+1）。 */
    public interface RelationTargetChecker {
        /** 目标记录（未删除）是否存在。 */
        boolean exists(String targetModelKey, Object value);
    }

    /**
     * 校验单个字段值（cleaned 已剔除未知/不可编辑字段后的待写集）。
     *
     * @param errors     聚合错误表（fieldKey → message）
     * @param checker    relation 目标存在性回调；null = 跳过 relation 校验（内部调用容错）
     */
    public static void validate(FieldMeta field, Object value, Map<String, String> errors,
            RelationTargetChecker checker) {
        // null/空白：required 校验已在引擎侧完成，此处放行（清空语义）
        if (value == null || (value instanceof String s && s.isBlank())) {
            return;
        }
        String type = field.fieldType() == null ? "text" : field.fieldType();
        switch (type) {
            case "number", "computed" -> {
                BigDecimal num = asNumber(value);
                if (num == null) {
                    errors.put(field.fieldKey(), "须为数值");
                    return;
                }
                applyRange(field, num, errors);
            }
            case "boolean" -> {
                if (!(value instanceof Boolean) && !"true".equalsIgnoreCase(String.valueOf(value))
                        && !"false".equalsIgnoreCase(String.valueOf(value))) {
                    errors.put(field.fieldKey(), "须为布尔值");
                }
            }
            case "date" -> {
                if (!isDateLike(value)) {
                    errors.put(field.fieldKey(), "须为日期（ISO8601 或时间戳）");
                }
            }
            case "enum" -> {
                Set<String> allowed = enumValues(field);
                if (allowed != null && !allowed.isEmpty() && !allowed.contains(String.valueOf(value))) {
                    errors.put(field.fieldKey(), "枚举值越界: " + value);
                }
            }
            case "text", "richtext" -> {
                if (value instanceof String s) {
                    applyMaxLength(field, s, errors);
                }
            }
            case "relation" -> {
                if (checker != null && field.relationConfig() != null) {
                    Object target = field.relationConfig().get("targetModelId");
                    if (target != null && !checker.exists(String.valueOf(target), value)) {
                        errors.put(field.fieldKey(), "关联目标记录不存在");
                    }
                }
            }
            default -> {
                // file/geo/user/dept：MVP 无结构约束（结构校验随物料启用接线）
            }
        }
        // validators 编译（range/regex/expression——01BE 字段定义协议）
        applyValidators(field, value, errors);
    }

    /** 聚合校验入口：错误非空时抛 VALIDATION_FAILED（附字段错误表）。 */
    public static void throwIfFailed(Map<String, String> errors) {
        if (!errors.isEmpty()) {
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("fields", errors);
            throw new BizException("VALIDATION_FAILED", "字段校验失败: "
                    + String.join(", ", errors.keySet()), detail);
        }
    }

    // ---------- validators 数组（01BE：[{type:'range',min,max},{type:'regex',pattern},{type:'expression',expr}]） ----------

    private static void applyValidators(FieldMeta field, Object value, Map<String, String> errors) {
        List<Map<String, Object>> validators = field.validators();
        if (validators == null) {
            return;
        }
        for (Map<String, Object> v : validators) {
            if (!(v instanceof Map<?, ?>)) {
                continue;
            }
            Object type = v.get("type");
            if ("regex".equals(type) && v.get("pattern") instanceof String pattern) {
                try {
                    if (!Pattern.matches(pattern, String.valueOf(value))) {
                        errors.put(field.fieldKey(), "不符合格式要求");
                    }
                } catch (PatternSyntaxException e) {
                    errors.put(field.fieldKey(), "校验器正则配置非法");
                }
            } else if ("expression".equals(type) && v.get("expr") instanceof String expr) {
                // L1 表达式校验随 M6 ExprEngine 接线（表达式上下文需行级值依赖图）；此处仅结构登记
            }
            // range 在类型分支已按 min/max 应用（validators 内 range 与字段级 min/max 同源）
        }
    }

    private static void applyRange(FieldMeta field, BigDecimal num, Map<String, String> errors) {
        List<Map<String, Object>> validators = field.validators();
        if (validators == null) {
            return;
        }
        for (Map<String, Object> v : validators) {
            if ("range".equals(v.get("type"))) {
                if (v.get("min") instanceof Number min && num.compareTo(toDecimal(min)) < 0) {
                    errors.put(field.fieldKey(), "小于最小值 " + min);
                }
                if (v.get("max") instanceof Number max && num.compareTo(toDecimal(max)) > 0) {
                    errors.put(field.fieldKey(), "大于最大值 " + max);
                }
            }
        }
    }

    private static void applyMaxLength(FieldMeta field, String value, Map<String, String> errors) {
        List<Map<String, Object>> validators = field.validators();
        if (validators == null) {
            return;
        }
        for (Map<String, Object> v : validators) {
            if ("length".equals(v.get("type")) && v.get("max") instanceof Number max
                    && value.length() > max.intValue()) {
                errors.put(field.fieldKey(), "超出长度上限 " + max.intValue());
            }
        }
    }

    // ---------- 工具 ----------

    private static Set<String> enumValues(FieldMeta field) {
        List<Map<String, Object>> options = field.enumOptions();
        if (options == null || options.isEmpty()) {
            return null; // 未配置枚举选项：不做值域强校验（配置面缺失不阻断写入）
        }
        Set<String> values = new HashSet<>();
        for (Map<String, Object> o : options) {
            Object v = o == null ? null : o.get("value");
            if (v != null && !"DEPRECATED".equals(o.get("status"))) {
                values.add(String.valueOf(v)); // DEPRECATED 选项不可再写（可读旧值）
            }
        }
        return values;
    }

    private static BigDecimal asNumber(Object value) {
        if (value instanceof Number n) {
            return toDecimal(n);
        }
        try {
            return new BigDecimal(String.valueOf(value));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static BigDecimal toDecimal(Number n) {
        return n instanceof BigDecimal d ? d : new BigDecimal(n.toString());
    }

    private static boolean isDateLike(Object value) {
        if (value instanceof Number) {
            return true; // epoch 时间戳
        }
        String s = String.valueOf(value);
        if (s.isBlank()) {
            return false;
        }
        try {
            java.time.OffsetDateTime.parse(s);
            return true;
        } catch (Exception ignored) {
            // fallthrough
        }
        try {
            java.time.LocalDate.parse(s);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    /** 收集全部 relation 字段的批量目标存在性校验入参（防逐行 N+1）。 */
    public static Map<String, List<Object>> collectRelationChecks(List<FieldMeta> fields,
            Map<String, Object> data) {
        Map<String, List<Object>> result = new LinkedHashMap<>();
        for (FieldMeta f : fields) {
            if (!"relation".equals(f.fieldType()) || f.relationConfig() == null
                    || f.relationConfig().get("targetModelId") == null) {
                continue;
            }
            Object value = data.get(f.fieldKey());
            if (value != null && !String.valueOf(value).isBlank()) {
                result.computeIfAbsent(String.valueOf(f.relationConfig().get("targetModelId")),
                        k -> new ArrayList<>()).add(value);
            }
        }
        return result;
    }
}
