package com.schema.data.domain.engine;

import com.schema.data.domain.repository.MetadataPort.FieldMeta;
import com.schema.platform.common.web.BizException;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 动态 SQL 构建器（02BE §3.2/§3.3）——白名单防注入的唯一收口处。
 *
 * 安全铁律：
 * 1. 字段名：仅来自元数据白名单（fieldMeta 缓存集），请求传入的字段名不在集合内即 400；
 * 2. 操作符：白名单枚举（eq/ne/in/nin/like/between/gt/gte/lt/lte/isnull），越界 400；
 * 3. 值：一律 PreparedStatement 占位符（?），永不拼进 SQL 文本；
 * 4. 固定条件段顺序不可变：tenant_id → deleted_at IS NULL → 行级权限（§3.3 第 4 步）。
 *
 * 字段→物理表达式映射（§3.3 第 3 步）：
 *   promoted（indexed 且 promote_status='ACTIVE'）→ 列直查  status = ?
 *   否则 → (data->>'amount')::numeric 等（按字段类型 cast）
 */
public final class SqlBuilder {

    /** 操作符白名单（02BE §3.2）。 */
    public static final Set<String> OPERATORS = Set.of(
            "eq", "ne", "in", "nin", "like", "between", "gt", "gte", "lt", "lte", "isnull");

    private static final Set<String> NUMERIC_TYPES = Set.of("number");
    private static final Set<String> DATE_TYPES = Set.of("date");
    private static final Set<String> BOOL_TYPES = Set.of("boolean");

    private SqlBuilder() {
    }

    /** 查询请求（02BE §3.1）。 */
    public record QueryRequest(long modelId, Map<String, Object> filter, List<Map<String, Object>> sorts,
            int page, int size, List<String> fields, int relationDepth,
            boolean includeDeletedFields) {
    }

    /** 构建产物：SQL 文本（含占位符）+ 有序参数表。 */
    public record Built(String sql, List<Object> params) {
    }

    /**
     * 字段物理表达式（提升列直查 / JSONB 表达式）——注入防线第一道：
     * fieldKey 必须在元数据字段集内，否则 FIELD_INVALID。
     */
    public static String fieldExpr(String fieldKey, FieldMeta meta) {
        if (meta.promoted()) {
            return "\"" + meta.fieldKey() + "\"";
        }
        String key = PhysicalIdent.column(fieldKey);
        String cast = switch (meta.fieldType()) {
            case "number", "computed" -> "::numeric";
            case "date" -> "::timestamptz";
            case "boolean" -> "::boolean";
            default -> "";
        };
        return "(data->>'" + key + "')" + cast;
    }

    /**
     * 条件树 → SQL 片段（AND/OR 嵌套递归）。
     * 节点形态：{op: 'AND'|'OR', conds: [...]} 组节点；{field, op, value} 叶节点。
     */
    public static void buildCondition(Object filter, Map<String, FieldMeta> fieldsBy,
            List<Object> params, StringBuilder out, String alias) {
        StringBuilder sb = out;
        buildNode(filter, fieldsBy, params, sb, alias);
    }

    private static void buildNode(Object node, Map<String, FieldMeta> fieldsBy,
            List<Object> params, StringBuilder sb, String alias) {
        if (!(node instanceof Map<?, ?> m) || m.isEmpty()) {
            return; // 空过滤 = 无附加条件
        }
        Object op = m.get("op");
        Object conds = m.get("conds");
        if (conds instanceof List<?> list) {
            // 组节点：AND/OR（白名单外 400）
            if (!"AND".equals(op) && !"OR".equals(op)) {
                throw new BizException("FILTER_OPERATOR_INVALID", "非法逻辑操作符: " + op);
            }
            List<String> parts = new ArrayList<>();
            for (Object c : list) {
                StringBuilder child = new StringBuilder();
                buildNode(c, fieldsBy, params, child, alias);
                if (!child.isEmpty()) {
                    parts.add("(" + child + ")");
                }
            }
            if (parts.isEmpty()) {
                return;
            }
            sb.append(String.join(" " + op + " ", parts));
            return;
        }
        // 叶节点：{field, op, value}
        String field = String.valueOf(m.get("field"));
        String operator = String.valueOf(m.get("op"));
        FieldMeta meta = fieldsBy.get(field);
        if (meta == null || !meta.active()) {
            // DELETED 字段或不存在的字段一律 FIELD_DELETED 同判（不给数据线索，02BE §A.6）
            throw new BizException("FIELD_DELETED", "字段不可用: " + field);
        }
        if (!OPERATORS.contains(operator)) {
            throw new BizException("FILTER_OPERATOR_INVALID", "非法操作符: " + operator);
        }
        String expr = aliasPrefix(alias) + fieldExpr(field, meta);
        sb.append(leafCondition(expr, operator, m.get("value"), meta, params));
    }

    /** 叶节点条件（值全占位符）。 */
    private static String leafCondition(String expr, String operator, Object value,
            FieldMeta meta, List<Object> params) {
        switch (operator) {
            case "eq" -> {
                params.add(normalizeValue(value, meta));
                return expr + " = ?";
            }
            case "ne" -> {
                params.add(normalizeValue(value, meta));
                return expr + " <> ?";
            }
            case "like" -> {
                params.add("%" + String.valueOf(value) + "%");
                return expr + " LIKE ?";
            }
            case "gt", "gte", "lt", "lte" -> {
                String sqlOp = switch (operator) {
                    case "gt" -> ">";
                    case "gte" -> ">=";
                    case "lt" -> "<";
                    default -> "<=";
                };
                params.add(normalizeValue(value, meta));
                return expr + " " + sqlOp + " ?";
            }
            case "in", "nin" -> {
                if (!(value instanceof List<?> values) || values.isEmpty()) {
                    throw new BizException("FILTER_OPERATOR_INVALID", "in/nin 需非空数组值");
                }
                List<Object> normalized = new ArrayList<>();
                for (Object v : values) {
                    normalized.add(normalizeValue(v, meta));
                }
                StringBuilder in = new StringBuilder("(");
                for (int i = 0; i < normalized.size(); i++) {
                    if (i > 0) {
                        in.append(",");
                    }
                    in.append("?");
                }
                in.append(")");
                params.addAll(normalized);
                return expr + ("in".equals(operator) ? " IN " : " NOT IN ") + in;
            }
            case "between" -> {
                if (!(value instanceof List<?> pair) || pair.size() != 2) {
                    throw new BizException("FILTER_OPERATOR_INVALID", "between 需 [min, max] 二值");
                }
                params.add(normalizeValue(pair.get(0), meta));
                params.add(normalizeValue(pair.get(1), meta));
                return expr + " BETWEEN ? AND ?";
            }
            case "isnull" -> {
                boolean isNull = !(value instanceof Boolean b) || b;
                return isNull ? "(" + expr + " IS NULL OR " + expr + " = 'null'::jsonb)"
                        : "(" + expr + " IS NOT NULL AND " + expr + " <> 'null'::jsonb)";
            }
            default -> throw new BizException("FILTER_OPERATOR_INVALID", "非法操作符: " + operator);
        }
    }

    /** 值规范化：数值字段传字符串数字自动转 Number（Gson 反序列化 Map 值为 Double/Long）。 */
    private static Object normalizeValue(Object value, FieldMeta meta) {
        if (value == null) {
            return null;
        }
        if (NUMERIC_TYPES.contains(meta.fieldType())) {
            if (value instanceof Number n) {
                return n;
            }
            try {
                return new java.math.BigDecimal(String.valueOf(value));
            } catch (NumberFormatException e) {
                throw new BizException("FILTER_OPERATOR_INVALID",
                        "字段 " + meta.fieldKey() + " 需数值");
            }
        }
        return value;
    }

    private static String aliasPrefix(String alias) {
        return alias == null ? "" : alias + ".";
    }

    /** 物理标识符白名单（与 PhysicalTableManager.SAFE_IDENT 同源——单独抽出防环依赖）。 */
    public static final class PhysicalIdent {
        private static final java.util.regex.Pattern SAFE =
                java.util.regex.Pattern.compile("^[a-z_][a-z0-9_]{0,62}$");

        public static String column(String fieldKey) {
            if (fieldKey == null || !SAFE.matcher(fieldKey).matches()) {
                throw new BizException("FILTER_OPERATOR_INVALID", "非法字段标识符: " + fieldKey);
            }
            return fieldKey;
        }
    }
}
