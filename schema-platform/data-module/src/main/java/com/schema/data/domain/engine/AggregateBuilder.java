package com.schema.data.domain.engine;

import com.schema.data.domain.repository.MetadataPort.FieldMeta;
import com.schema.data.domain.repository.MetadataPort.ModelMeta;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 聚合查询构建器（02BE §3.6）：分组/时间桶/topN 截断。
 * 复用 §3.3 管线（元数据校验 + 固定条件注入 + 权限一致）——聚合结果同样受行级权限约束。
 */
public final class AggregateBuilder {

    private AggregateBuilder() {
    }

    /** 聚合请求（02BE §3.6 AggregateRequest）。 */
    public record AggMeasure(String fieldKey, String func) {
    }

    public record AggRequest(long modelId, Map<String, Object> filter,
            List<AggMeasure> measures, String groupField, Integer groupTopN,
            String bucketField, String bucketInterval) {
    }

    private static final java.util.Set<String> AGG_FUNCS = java.util.Set.of(
            "SUM", "AVG", "COUNT", "COUNT_DISTINCT", "MAX", "MIN");
    /** 时间桶间隔白名单（02BE §3.6——执行路径校验，未校验文本永不拼入 SQL）。 */
    public static final java.util.Set<String> BUCKET_INTERVALS = java.util.Set.of(
            "DAY", "WEEK", "MONTH");
    /** 桶数上限（02BE §3.6 第 7 步：桶数 > 1000 拒绝）。 */
    public static final int MAX_BUCKETS = 1000;
    /** 聚合超时秒数（02BE §3.6 第 7 步：超时熔断）。 */
    public static final int AGG_TIMEOUT_SECONDS = 10;

    /** 构建聚合 SQL（维度 + 度量 + GROUP BY + topN 子查询包装）。 */
    public static String build(AggRequest req, Map<String, FieldMeta> fieldsBy,
            List<Object> params, String fixedConditions) {
        List<String> dimensions = new ArrayList<>();
        List<String> selects = new ArrayList<>();
        List<String> groups = new ArrayList<>();

        // 维度：分组字段 / 时间桶（可同时存在——桶为第一维度）
        if (req.bucketField() != null) {
            FieldMeta bf = requireActive(req.bucketField(), fieldsBy);
            if (!"date".equals(bf.fieldType())) {
                throw new com.schema.platform.common.web.BizException(
                        "FILTER_OPERATOR_INVALID", "时间桶字段须为 date 类型: " + req.bucketField());
            }
            if (!BUCKET_INTERVALS.contains(req.bucketInterval())) {
                throw new com.schema.platform.common.web.BizException(
                        "FILTER_OPERATOR_INVALID", "非法分桶间隔: " + req.bucketInterval());
            }
            String trunc = "date_trunc('" + req.bucketInterval().toLowerCase() + "', "
                    + SqlBuilder.fieldExpr(req.bucketField(), bf) + ")";
            dimensions.add("bucket");
            selects.add(trunc + " AS bucket");
            groups.add(trunc);
        }
        if (req.groupField() != null) {
            FieldMeta gf = requireActive(req.groupField(), fieldsBy);
            String expr = SqlBuilder.fieldExpr(req.groupField(), gf);
            dimensions.add("dimension");
            selects.add(expr + " AS dimension");
            groups.add(expr);
        }

        // 度量（1-5 个）
        if (req.measures() == null || req.measures().isEmpty()
                || req.measures().size() > 5) {
            throw new com.schema.platform.common.web.BizException(
                    "FILTER_OPERATOR_INVALID", "度量数量须为 1-5");
        }
        List<String> aggExprs = new ArrayList<>();
        for (int i = 0; i < req.measures().size(); i++) {
            AggMeasure m = req.measures().get(i);
            String func = m.func() == null ? "" : m.func().toUpperCase();
            if (!AGG_FUNCS.contains(func)) {
                throw new com.schema.platform.common.web.BizException(
                        "FILTER_OPERATOR_INVALID", "非法聚合函数: " + m.func());
            }
            String expr;
            if ("__count".equals(m.fieldKey())) {
                if (!"COUNT".equals(func)) {
                    throw new com.schema.platform.common.web.BizException(
                            "FILTER_OPERATOR_INVALID", "__count 伪字段仅支持 COUNT");
                }
                expr = "COUNT(*)";
            } else {
                FieldMeta mf = requireActive(m.fieldKey(), fieldsBy);
                String fieldExpr = SqlBuilder.fieldExpr(m.fieldKey(), mf);
                expr = switch (func) {
                    case "COUNT" -> "COUNT(" + fieldExpr + ")";
                    case "COUNT_DISTINCT" -> "COUNT(DISTINCT " + fieldExpr + ")";
                    case "SUM", "AVG" -> {
                        if (!"number".equals(mf.fieldType()) && !"computed".equals(mf.fieldType())) {
                            throw new com.schema.platform.common.web.BizException(
                                    "FILTER_OPERATOR_INVALID", func + " 须数值字段: " + m.fieldKey());
                        }
                        yield func + "(" + fieldExpr + ")";
                    }
                    default -> func + "(" + fieldExpr + ")";
                };
            }
            selects.add(expr + " AS m" + i);
            aggExprs.add("m" + i);
        }

        // WHERE 固定段 + 过滤树
        StringBuilder where = new StringBuilder(" WHERE tenant_id = ? AND deleted_at IS NULL");
        params.add(0, req.modelId()); // 由调用方重排 tenant_id 参数——见引擎侧注释
        StringBuilder filterPart = new StringBuilder();
        SqlBuilder.buildCondition(req.filter(), fieldsBy, params, filterPart, null);
        if (!filterPart.isEmpty()) {
            where.append(" AND (").append(filterPart).append(")");
        }
        // 行级权限段（调用方已拼接在 fixedConditions——参数序由引擎统一管理）
        if (fixedConditions != null && !fixedConditions.isBlank()) {
            where.append(" AND (").append(fixedConditions).append(")");
        }

        String sql;
        if (groups.isEmpty()) {
            // 无分组：全表单值聚合
            sql = "SELECT " + String.join(", ", selects) + " FROM {TABLE}" + where;
        } else {
            int topN = req.groupTopN() == null ? 10 : Math.min(req.groupTopN(), 50);
            sql = "SELECT * FROM (SELECT " + String.join(", ", selects)
                    + " FROM {TABLE}" + where
                    + " GROUP BY " + String.join(", ", groups)
                    + " ORDER BY m0 DESC LIMIT " + topN + ") agg_order";
        }
        return sql;
    }

    /** 响应组装（02BE §3.6 第 6 步）。 */
    public static List<Map<String, Object>> toRows(List<Map<String, Object>> rows,
            List<AggMeasure> measures, boolean hasBucket, boolean hasGroup) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (Map<String, Object> raw : rows) {
            Map<String, Object> row = new LinkedHashMap<>();
            if (hasBucket) {
                row.put("bucket", raw.get("bucket"));
            }
            if (hasGroup) {
                row.put("dimension", raw.get("dimension"));
            }
            List<Map<String, Object>> values = new ArrayList<>();
            for (int i = 0; i < measures.size(); i++) {
                Map<String, Object> v = new LinkedHashMap<>();
                v.put("func", measures.get(i).func());
                v.put("fieldKey", measures.get(i).fieldKey());
                v.put("value", raw.get("m" + i));
                values.add(v);
            }
            row.put("values", values);
            result.add(row);
        }
        return result;
    }

    private static FieldMeta requireActive(String fieldKey, Map<String, FieldMeta> fieldsBy) {
        FieldMeta f = fieldsBy.get(fieldKey);
        if (f == null || !f.active()) {
            throw new com.schema.platform.common.web.BizException(
                    "FIELD_DELETED", "聚合字段不可用: " + fieldKey);
        }
        return f;
    }

    /**
     * 桶跨度防护（02BE §3.6 第 7 步，2026-10-30 二轮收口）：
     * 带时间桶时 filter 必须含桶字段双边范围条件（gte+lte/gt+lt/between），
     * 且跨度按 interval 换算桶数 ≤ MAX_BUCKETS——否则拒绝（防无限桶扫描）。
     * 单边条件（只有 gte 或只有 lte）不再放行。
     */
    public static void guardBucketSpan(ModelMeta model, String bucketField, String interval,
            Map<String, Object> filter) {
        if (bucketField == null) {
            return;
        }
        Double min = null;
        Double max = null;
        collectBucketBounds(filter, bucketField, null);
        double[] bounds = BOUNDS.get();
        BOUNDS.remove();
        if (!Double.isNaN(bounds[0])) {
            min = bounds[0];
        }
        if (!Double.isNaN(bounds[1])) {
            max = bounds[1];
        }
        if (min == null || max == null) {
            throw new com.schema.platform.common.web.BizException("FILTER_OPERATOR_INVALID",
                    "时间桶聚合必须在 filter 中限定桶字段双边范围（gte+lte / between）: " + bucketField);
        }
        if (max < min) {
            throw new com.schema.platform.common.web.BizException("FILTER_OPERATOR_INVALID",
                    "时间桶范围颠倒: " + bucketField);
        }
        long buckets = bucketCount(min, max, interval == null ? "" : interval.toUpperCase());
        if (buckets > MAX_BUCKETS) {
            throw new com.schema.platform.common.web.BizException("FILTER_OPERATOR_INVALID",
                    "时间桶数超限（" + buckets + " > " + MAX_BUCKETS + "）——请缩小范围");
        }
    }

    /** 递归收集线程暂存（collectBucketBounds 往返传参——领域纯函数避免逐层 new 数组）。 */
    private static final ThreadLocal<double[]> BOUNDS = ThreadLocal.withInitial(
            () -> new double[]{Double.NaN, Double.NaN});

    /**
     * 递归提取条件树中桶字段的下/上界（epoch 毫秒）。
     * 认可的边界操作符：gte/gt → 下界；lte/lt → 上界；between → 双界。
     * eq（等值）视作跨度 0 的合法范围。
     */
    private static void collectBucketBounds(Object node, String bucketField, double[] ignored) {        if (!(node instanceof Map<?, ?> m)) {
            return;
        }
        if (bucketField.equals(m.get("field"))) {
            String op = String.valueOf(m.get("op"));
            Object v = m.get("value");
            double[] b = BOUNDS.get();
            switch (op) {
                case "gte", "gt" -> setBound(b, v, 0);
                case "lte", "lt" -> setBound(b, v, 1);
                case "eq" -> {
                    setBound(b, v, 0);
                    setBound(b, v, 1);
                }
                case "between" -> {
                    if (v instanceof List<?> pair && pair.size() == 2) {
                        setBound(b, pair.get(0), 0);
                        setBound(b, pair.get(1), 1);
                    }
                }
                default -> {
                    // in/nin/like/isnull 等不构成连续范围——不参与跨度换算
                }
            }
        }
        if (m.get("conds") instanceof List<?> conds) {
            for (Object c : conds) {
                collectBucketBounds(c, bucketField, ignored);
            }
        }
    }

    /** 边界写入（保留最紧界：下界取最大、上界取最小——多条件 AND 语义）。 */
    private static void setBound(double[] b, Object value, int idx) {
        Double ms = toEpochMillis(value);
        if (ms == null) {
            return;
        }
        if (idx == 0) {
            if (Double.isNaN(b[0]) || ms > b[0]) {
                b[0] = ms;
            }
        } else {
            if (Double.isNaN(b[1]) || ms < b[1]) {
                b[1] = ms;
            }
        }
    }

    /** 值转 epoch 毫秒：数值（秒/毫秒自适应）或 ISO 日期文本。 */
    private static Double toEpochMillis(Object v) {
        try {
            if (v instanceof Number n) {
                double d = n.doubleValue();
                return d < 1e11 ? d * 1000.0 : d;
            }
            if (v instanceof String s && !s.isBlank()) {
                return (double) java.time.Instant.parse(normalizeIso(s)).toEpochMilli();
            }
        } catch (Exception ignored) {
            // 无法解析的边界值：留给执行层类型校验报错（此处不拦截）
        }
        return null;
    }

    /** ISO 文本规范化：纯日期补 UTC 零点（Instant.parse 要求完整时间形态）。 */
    private static String normalizeIso(String s) {
        if (s.length() == 10) {
            return s + "T00:00:00Z";
        }
        if (s.length() == 16) {
            return s + ":00Z";
        }
        if (s.endsWith("Z") || s.contains("+") || (s.length() > 10 && s.charAt(10) == 'T'
                && !s.endsWith("Z") && !s.contains(":"))) {
            return s;
        }
        if (s.length() > 10 && s.charAt(10) == 'T') {
            return s + "Z";
        }
        return s;
    }

    /** 跨度换算桶数：DAY=86400s / WEEK=7 天 / MONTH≈30.44 天（保守估计防绕过）。 */
    private static long bucketCount(double minMs, double maxMs, String interval) {
        double spanMs = Math.max(0, maxMs - minMs);
        return switch (interval) {
            case "DAY" -> (long) Math.ceil(spanMs / 86_400_000.0);
            case "WEEK" -> (long) Math.ceil(spanMs / (7 * 86_400_000.0));
            case "MONTH" -> (long) Math.ceil(spanMs / (30.44 * 86_400_000.0));
            default -> Long.MAX_VALUE; // 白名单外 interval 由调用方先行拦截
        };
    }

    /** 解析聚合请求体（A.4 协议）。 */
    public static AggRequest parseRequest(long modelId, Map<String, Object> body) {
        if (body == null) {
            throw new com.schema.platform.common.web.BizException("FILTER_OPERATOR_INVALID",
                    "聚合请求体缺失");
        }
        List<AggMeasure> measures = new ArrayList<>();
        Object raw = body.get("measures");
        if (raw instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> m && m.get("fieldKey") != null && m.get("func") != null) {
                    measures.add(new AggMeasure(String.valueOf(m.get("fieldKey")),
                            String.valueOf(m.get("func"))));
                }
            }
        }
        Integer topN = body.get("groupTopN") instanceof Number n ? n.intValue() : null;
        return new AggRequest(modelId,
                (Map<String, Object>) body.get("filter"),
                measures,
                (String) body.get("groupField"),
                topN,
                (String) body.get("bucketField"),
                (String) body.get("bucketInterval"));
    }
}
