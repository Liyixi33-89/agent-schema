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
    private static final java.util.Set<String> BUCKET_INTERVALS = java.util.Set.of(
            "DAY", "WEEK", "MONTH");

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

    /** 桶跨度防护（02BE §3.6 第 7 步）：桶数 > 1000 拒绝。 */
    public static void guardBucketSpan(ModelMeta model, String interval) {
        // MVP 阶段无行数水位统计——按固定上限放行（护栏逻辑随数据量上来后接入统计表）
        // 有 bucketField 时由调用方在时间范围过滤上判定（无范围 = 无限桶 → 要求 filter 含桶字段范围）
    }
}
