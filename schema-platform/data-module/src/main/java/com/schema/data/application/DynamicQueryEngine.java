package com.schema.data.application;

import com.schema.data.domain.engine.AggregateBuilder;
import com.schema.data.domain.engine.AggregateBuilder.AggMeasure;
import com.schema.data.domain.engine.AggregateBuilder.AggRequest;
import com.schema.data.domain.engine.ReadCompatibility;
import com.schema.data.domain.engine.ScopeResolver;
import com.schema.data.domain.engine.SqlBuilder;
import com.schema.data.domain.engine.SqlBuilder.QueryRequest;
import com.schema.data.domain.repository.DataPermissionPort;
import com.schema.data.domain.repository.MetadataPort;
import com.schema.data.domain.repository.MetadataPort.FieldMeta;
import com.schema.data.domain.repository.MetadataPort.ModelMeta;
import com.schema.data.infrastructure.table.PhysicalTableManager;
import com.schema.platform.common.json.Json;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * 元数据驱动通用数据引擎（02BE §3）——所有业务数据读写的唯一通道（§5 铁律）。
 *
 * SQL 构建管线（§3.3，顺序不可变）：
 *   元数据加载与校验 → 字段物理映射 → 固定条件注入（tenant/deleted/行级权限）→
 *   过滤树 → 投影与字段权限剔除 → 参数化执行 → 读时兼容 → 响应
 */
@Service
public class DynamicQueryEngine {

    private static final Logger log = LoggerFactory.getLogger(DynamicQueryEngine.class);
    private static final int MAX_SIZE = 200;
    private static final long MAX_OFFSET = 100_000L;

    private final JdbcTemplate jdbc;
    private final MetadataPort metadata;
    private final DataPermissionPort permissions;
    private final PhysicalTableManager tables;

    public DynamicQueryEngine(JdbcTemplate jdbc, MetadataPort metadata,
            DataPermissionPort permissions, PhysicalTableManager tables) {
        this.jdbc = jdbc;
        this.metadata = metadata;
        this.permissions = permissions;
        this.tables = tables;
    }

    // ---------- §3.1 query ----------

    @Transactional(readOnly = true)
    public Map<String, Object> query(QueryRequest req) {
        EngineContext ctx = prepare(req.modelId(), req.filter(), req.includeDeletedFields());
        int size = Math.min(Math.max(req.size(), 1), MAX_SIZE);
        int page = Math.max(req.page(), 1);
        if ((long) page * size > MAX_OFFSET) {
            throw new BizException("PAGE_TOO_DEEP", "深分页超限，请缩小范围或走游标");
        }

        StringBuilder where = new StringBuilder(" WHERE tenant_id = ? AND deleted_at IS NULL");
        List<Object> params = new ArrayList<>(List.of(ctx.tenant.tenantId()));

        // 过滤树（字段/操作符白名单 + 值占位符）
        StringBuilder filterPart = new StringBuilder();
        SqlBuilder.buildCondition(req.filter(), ctx.fieldsBy, params, filterPart, null);
        if (!filterPart.isEmpty()) {
            where.append(" AND (").append(filterPart).append(")");
        }
        // 行级权限注入（顺序固定在最后——不可被过滤树短路；scope 参数在过滤参数之后）
        where.append(" AND (").append(ctx.scopeSql).append(")");
        params.addAll(ctx.scopeParams);

        // 排序（字段须 ACTIVE——白名单外 400）
        StringBuilder order = new StringBuilder(" ORDER BY ");
        if (req.sorts() == null || req.sorts().isEmpty()) {
            order.append("id DESC");
        } else {
            List<String> parts = new ArrayList<>();
            for (Map<String, Object> s : req.sorts()) {
                String field = String.valueOf(s.get("field"));
                FieldMeta meta = requireActive(field, ctx.fieldsBy);
                String dir = "desc".equalsIgnoreCase(String.valueOf(s.get("order"))) ? "DESC" : "ASC";
                parts.add(SqlBuilder.fieldExpr(field, meta) + " " + dir);
            }
            order.append(String.join(", ", parts));
        }

        String table = ctx.table;
        String listSql = "SELECT id, data, schema_version FROM " + table + where + order
                + " LIMIT ? OFFSET ?";
        params.add(size);
        params.add((page - 1) * size);
        List<Map<String, Object>> rows = jdbc.queryForList(listSql, params.toArray());

        String countSql = "SELECT COUNT(*) FROM " + table + where;
        long total = jdbc.queryForObject(countSql, params.subList(0, params.size() - 2).toArray(),
                Long.class);

        // 读时兼容 + 字段权限剔除 + 投影
        List<FieldMeta> visibleFields = visibleFields(ctx);
        List<Map<String, Object>> list = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            list.add(project(readRow(row, visibleFields, ctx), req.fields(), visibleFields));
        }
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("list", list);
        resp.put("total", total);
        resp.put("page", page);
        resp.put("size", size);
        return resp;
    }

    // ---------- §3.1 getById ----------

    @Transactional(readOnly = true)
    public Map<String, Object> getById(long modelId, long id) {
        EngineContext ctx = prepare(modelId, null, false);
        // 行级权限在 SQL 层强制（不可见同判不存在——不给线索，02BE §A.6）
        String sql = "SELECT id, data, schema_version FROM " + ctx.table
                + " WHERE tenant_id = ? AND deleted_at IS NULL AND id = ? AND (" + ctx.scopeSql + ")";
        List<Object> params = new ArrayList<>(List.of(ctx.tenant.tenantId(), id));
        params.addAll(ctx.scopeParams);
        List<Map<String, Object>> rows = jdbc.queryForList(sql, params.toArray());
        if (rows.isEmpty()) {
            throw BizException.recordNotFound();
        }
        List<FieldMeta> visibleFields = visibleFields(ctx);
        return project(readRow(rows.get(0), visibleFields, ctx), null, visibleFields);
    }

    // ---------- §3.1 create ----------

    @Transactional
    public Map<String, Object> create(long modelId, Map<String, Object> data) {
        EngineContext ctx = prepare(modelId, null, false);
        String table = ctx.table;
        Map<String, Object> cleaned = writeNormalize(data, ctx, true);
        long id = Math.abs(UUID.randomUUID().getLeastSignificantBits()) >> 1 | 1;

        // 唯一性应用层预检（真唯一靠提升列 + 部分索引；02BE §3.4 第 5 步说明并发风险）
        checkUnique(table, ctx, cleaned, null);

        jdbc.update("INSERT INTO " + table + " (id, tenant_id, data, schema_version, created_by, "
                        + "created_at) VALUES (?, ?, ?::jsonb, ?, ?, now())",
                id, ctx.tenant.tenantId(), Json.write(cleaned), ctx.model.currentVersion(),
                ctx.tenant.operatorId());
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("id", id);
        return resp;
    }

    // ---------- §3.1 update ----------

    @Transactional
    public void update(long modelId, long id, Map<String, Object> data) {
        EngineContext ctx = prepare(modelId, null, false);
        String table = ctx.table;
        // 行级权限下的存在性判定：不可见记录同判不存在
        String existsSql = "SELECT data FROM " + table
                + " WHERE tenant_id = ? AND deleted_at IS NULL AND id = ? AND (" + ctx.scopeSql + ")";
        List<Object> existsParams = new ArrayList<>(List.of(ctx.tenant.tenantId(), id));
        existsParams.addAll(ctx.scopeParams);
        List<Map<String, Object>> existing = jdbc.queryForList(existsSql, existsParams.toArray());
        if (existing.isEmpty()) {
            throw BizException.recordNotFound();
        }
        // JSONB 列取回为 PGobject——统一文本解析
        Map<String, Object> currentData = Json.readMap(String.valueOf(existing.get(0).get("data")));
        if (currentData == null) {
            currentData = new LinkedHashMap<>();
        }
        // 不可编辑字段静默剔除（03BE §3.4——前端全量表单提交容错）
        Map<String, Object> cleaned = writeNormalize(mergeForUpdate(currentData, data, ctx), ctx, false);
        checkUnique(table, ctx, cleaned, id);
        jdbc.update("UPDATE " + table + " SET data = ?::jsonb, schema_version = ?, updated_at = now() "
                        + "WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
                Json.write(cleaned), ctx.model.currentVersion(), id, ctx.tenant.tenantId());
    }

    // ---------- §3.1 delete（逻辑删除） ----------

    @Transactional
    public void delete(long modelId, long id) {
        EngineContext ctx = prepare(modelId, null, false);
        String table = ctx.table;
        int updated = jdbc.update("UPDATE " + table
                        + " SET deleted_at = now() WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL "
                        + "AND (" + ctx.scopeSql + ")",
                concat(List.of(id, ctx.tenant.tenantId()), ctx.scopeParams).toArray());
        if (updated == 0) {
            throw BizException.recordNotFound();
        }
    }

    // ---------- A.3 唯一性校验 ----------

    @Transactional(readOnly = true)
    public Map<String, Object> uniqueCheck(long modelId, String fieldKey, Object value, Long excludeId) {
        EngineContext ctx = prepare(modelId, null, false);
        FieldMeta field = requireActive(fieldKey, ctx.fieldsBy);
        if (!field.uniqueFlag()) {
            // 非唯一字段：恒 true（协议容错——前端表单只对 unique 字段触发异步校验）
            Map<String, Object> resp = new LinkedHashMap<>();
            resp.put("unique", true);
            return resp;
        }
        String expr = SqlBuilder.fieldExpr(fieldKey, field);
        String sql = "SELECT COUNT(*) FROM " + ctx.table
                + " WHERE tenant_id = ? AND deleted_at IS NULL AND " + expr + " = ?"
                + (excludeId == null ? "" : " AND id <> ?");
        List<Object> params = new ArrayList<>(List.of(ctx.tenant.tenantId(), value));
        if (excludeId != null) {
            params.add(excludeId);
        }
        Long count = jdbc.queryForObject(sql, params.toArray(), Long.class);
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("unique", count == null || count == 0);
        return resp;
    }

    // ---------- A.4 聚合 ----------

    @Transactional(readOnly = true)
    public Map<String, Object> aggregate(AggRequest req) {
        EngineContext ctx = prepare(req.modelId(), req.filter(), false);
        List<AggMeasure> measures = new ArrayList<>();
        if (req.measures() != null) {
            for (AggMeasure m : req.measures()) {
                measures.add(m);
            }
        }
        // 参数序：tenant_id 固定第一，scope 参数随后，过滤参数最后
        List<Object> params = new ArrayList<>(List.of(ctx.tenant.tenantId()));
        params.addAll(ctx.scopeParams);

        StringBuilder filterPart = new StringBuilder();
        SqlBuilder.buildCondition(req.filter(), ctx.fieldsBy, params, filterPart, null);

        StringBuilder where = new StringBuilder(" WHERE tenant_id = ? AND deleted_at IS NULL");
        if (!filterPart.isEmpty()) {
            where.append(" AND (").append(filterPart).append(")");
        }
        where.append(" AND ").append(ctx.scopeSql);

        List<String> dims = new ArrayList<>();
        List<String> selects = new ArrayList<>();
        List<String> groups = new ArrayList<>();
        if (req.bucketField() != null) {
            FieldMeta bf = requireActive(req.bucketField(), ctx.fieldsBy);
            String trunc = "date_trunc('" + req.bucketInterval().toLowerCase() + "', "
                    + SqlBuilder.fieldExpr(req.bucketField(), bf) + ")";
            selects.add(trunc + " AS bucket");
            groups.add(trunc);
            dims.add("bucket");
        }
        if (req.groupField() != null) {
            FieldMeta gf = requireActive(req.groupField(), ctx.fieldsBy);
            String expr = SqlBuilder.fieldExpr(req.groupField(), gf);
            selects.add(expr + " AS dimension");
            groups.add(expr);
            dims.add("dimension");
        }
        for (int i = 0; i < measures.size(); i++) {
            selects.add(measureExpr(measures.get(i), ctx) + " AS m" + i);
        }

        String sql;
        if (groups.isEmpty()) {
            sql = "SELECT " + String.join(", ", selects) + " FROM " + ctx.table + where;
        } else {
            int topN = req.groupTopN() == null ? 10 : Math.min(Math.max(req.groupTopN(), 1), 50);
            sql = "SELECT * FROM (SELECT " + String.join(", ", selects)
                    + " FROM " + ctx.table + where
                    + " GROUP BY " + String.join(", ", groups)
                    + " ORDER BY m0 DESC LIMIT " + topN + ") agg_order";
        }
        List<Map<String, Object>> raw = jdbc.queryForList(sql, params.toArray());
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("rows", AggregateBuilder.toRows(raw, measures,
                req.bucketField() != null, req.groupField() != null));
        return resp;
    }

    // ---------- 建表入口（M2 建模时联动） ----------

    @Transactional
    public void ensurePhysicalTable(long tenantId, long modelId) {
        List<FieldMeta> fields = metadata.findFields(tenantId, modelId);
        List<Map<String, Object>> indexed = new ArrayList<>();
        for (FieldMeta f : fields) {
            if (f.indexed() && f.active()) {
                Map<String, Object> m = new HashMap<>();
                m.put("fieldKey", f.fieldKey());
                m.put("fieldType", f.fieldType());
                indexed.add(m);
            }
        }
        tables.ensureTable(tenantId, modelId, indexed);
    }

    // ---------- 管线内部 ----------

    /** 引擎上下文：元数据 + 权限段一次性解析（每请求一次，查询/写入共用）。 */
    private EngineContext prepare(long modelId, Map<String, Object> filter,
            boolean includeDeletedFields) {
        TenantInfo tenant = TenantContext.get();
        ModelMeta model = metadata.findModel(tenant.tenantId(), modelId)
                .orElseThrow(BizException::recordNotFound);
        if (!model.active()) {
            throw BizException.recordNotFound();
        }
        if (!tables.tableExists(modelId)) {
            // 未建物理表：建表幂等（首个数据请求触发——建模后未手动建表的窗口期兜底）
            ensurePhysicalTable(tenant.tenantId(), modelId);
        }
        List<FieldMeta> allFields = metadata.findFields(tenant.tenantId(), modelId);
        Map<String, FieldMeta> fieldsBy = new HashMap<>();
        for (FieldMeta f : allFields) {
            fieldsBy.put(f.fieldKey(), f);
        }
        // includeDeletedFields 白名单：仅管理员，记审计（02BE §3.1/A.2）
        if (includeDeletedFields) {
            log.info("includeDeletedFields 审计: tenant={} operator={} model={}",
                    tenant.tenantId(), tenant.operatorId(), modelId);
        }

        // 行级权限解析（03BE §3.3）
        List<Object> scopeParams = new ArrayList<>();
        String scopeSql;
        if (tenant.operatorId() <= 0) {
            scopeSql = "1 = 0"; // 无操作者上下文 = 默认拒绝
        } else {
            List<DataPermissionPort.ScopeCondition> scopes =
                    permissions.resolveScopes(tenant.tenantId(), tenant.operatorId(), modelId);
            scopeSql = ScopeResolver.resolve(scopes, tenant.operatorId(), 0, null, scopeParams);
        }
        return new EngineContext(tenant, model, fieldsBy,
                activeOf(allFields), PhysicalTableManager.tableName(modelId),
                scopeSql, scopeParams);
    }

    private record EngineContext(TenantInfo tenant, ModelMeta model,
            Map<String, FieldMeta> fieldsBy, List<FieldMeta> activeFields,
            String table, String scopeSql, List<Object> scopeParams) {
    }

    private static List<FieldMeta> activeOf(List<FieldMeta> all) {
        List<FieldMeta> result = new ArrayList<>();
        for (FieldMeta f : all) {
            if (f.active()) {
                result.add(f);
            }
        }
        return result;
    }

    /** 可见字段 = ACTIVE ∩ 字段权限授权（默认全可见——FIELD 授权集为空表示未配置字段权限）。 */
    private List<FieldMeta> visibleFields(EngineContext ctx) {
        Set<String> invisible = permissions.invisibleFields(ctx.tenant.tenantId(),
                ctx.tenant.operatorId(), ctx.model.id());
        List<FieldMeta> result = new ArrayList<>();
        for (FieldMeta f : ctx.activeFields) {
            if (!invisible.contains(f.fieldKey())) {
                result.add(f);
            }
        }
        return result;
    }

    /** 读时兼容入口（02BE §3.5）。 */
    private Map<String, Object> readRow(Map<String, Object> row, List<FieldMeta> fields,
            EngineContext ctx) {
        Object dataObj = row.get("data");
        Object parsed;
        if (dataObj instanceof Map<?, ?> m) {
            parsed = m;
        } else if (dataObj != null) {
            // JSONB 列 JDBC 取回为 PGobject（toString 即 JSON 文本）或 String——统一文本解析
            parsed = Json.readMap(String.valueOf(dataObj));
        } else {
            parsed = new LinkedHashMap<String, Object>();
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> data = (Map<String, Object>) parsed;
        data.put("_id", ((Number) row.get("id")).longValue());
        Object sv = row.get("schema_version");
        int schemaVersion = sv instanceof Number n ? n.intValue() : 0;
        return ReadCompatibility.readRow(data, fields, schemaVersion, ctx.model.currentVersion());
    }

    /** 投影：fields 为 null 全量；指定投影按可见字段交集（防伪造投影读取不可见字段）。 */
    private static Map<String, Object> project(Map<String, Object> row, List<String> fields,
            List<FieldMeta> visibleFields) {
        if (fields == null || fields.isEmpty()) {
            return row;
        }
        Set<String> visibleKeys = new HashSet<>();
        for (FieldMeta f : visibleFields) {
            visibleKeys.add(f.fieldKey());
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("_id", row.get("_id"));
        for (String f : fields) {
            if (visibleKeys.contains(f) && row.containsKey(f)) {
                result.put(f, row.get(f));
            }
        }
        if (row.containsKey("_invalid")) {
            result.put("_invalid", row.get("_invalid"));
        }
        return result;
    }

    /** 写入规范化：未知字段剔除 + required 校验 + DELETED 字段写入拒绝。 */
    private Map<String, Object> writeNormalize(Map<String, Object> data, EngineContext ctx,
            boolean isCreate) {
        if (data == null) {
            data = new LinkedHashMap<>();
        }
        Map<String, Object> cleaned = new LinkedHashMap<>();
        Set<String> uneditable = permissions.uneditableFields(ctx.tenant.tenantId(),
                ctx.tenant.operatorId(), ctx.model.id());
        List<String> missing = new ArrayList<>();
        for (FieldMeta f : ctx.activeFields) {
            if (data.containsKey(f.fieldKey())) {
                if (uneditable.contains(f.fieldKey())) {
                    continue; // 不可编辑静默忽略（03BE §3.4）
                }
                Object v = data.get(f.fieldKey());
                if (isCreate && f.required() && (v == null || String.valueOf(v).isBlank())) {
                    missing.add(f.fieldKey());
                    continue;
                }
                cleaned.put(f.fieldKey(), v);
            } else if (isCreate && f.required()) {
                if (f.defaultValue() != null) {
                    cleaned.put(f.fieldKey(), f.defaultValue());
                } else {
                    missing.add(f.fieldKey());
                }
            } else if (isCreate && f.defaultValue() != null && !"computed".equals(f.fieldType())) {
                cleaned.put(f.fieldKey(), f.defaultValue());
            }
        }
        if (!missing.isEmpty()) {
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("fields", missing);
            throw new BizException("VALIDATION_FAILED", "必填字段缺失: " + String.join(", ", missing));
        }
        return cleaned;
    }

    /** 更新合并：不可编辑字段保留库中现值（静默忽略语义——前端全量提交容错）。 */
    private Map<String, Object> mergeForUpdate(Map<String, Object> current,
            Map<String, Object> incoming, EngineContext ctx) {
        Map<String, Object> merged = new LinkedHashMap<>(current);
        Set<String> uneditable = permissions.uneditableFields(ctx.tenant.tenantId(),
                ctx.tenant.operatorId(), ctx.model.id());
        for (FieldMeta f : ctx.activeFields) {
            if (incoming.containsKey(f.fieldKey()) && !uneditable.contains(f.fieldKey())) {
                merged.put(f.fieldKey(), incoming.get(f.fieldKey()));
            }
        }
        return merged;
    }

    /** 唯一应用层预检（02BE §3.4 第 5 步：真唯一靠提升列部分索引，此处为友好报错）。 */
    private void checkUnique(String table, EngineContext ctx, Map<String, Object> data, Long excludeId) {
        for (FieldMeta f : ctx.activeFields) {
            if (f.uniqueFlag() && data.containsKey(f.fieldKey())) {
                String expr = SqlBuilder.fieldExpr(f.fieldKey(), f);
                String sql = "SELECT COUNT(*) FROM " + table
                        + " WHERE tenant_id = ? AND deleted_at IS NULL AND " + expr + " = ?"
                        + (excludeId == null ? "" : " AND id <> ?");
                List<Object> params = new ArrayList<>(
                        List.of(ctx.tenant.tenantId(), data.get(f.fieldKey())));
                if (excludeId != null) {
                    params.add(excludeId);
                }
                Long count = jdbc.queryForObject(sql, params.toArray(), Long.class);
                if (count != null && count > 0) {
                    throw new BizException("VALIDATION_FAILED",
                            "唯一字段重复: " + f.fieldKey());
                }
            }
        }
    }

    /** 聚合函数白名单（02BE §3.6）。 */
    private static final Set<String> AGG_FUNCS = Set.of(
            "SUM", "AVG", "COUNT", "COUNT_DISTINCT", "MAX", "MIN");

    private static String measureExpr(AggMeasure m, EngineContext ctx) {
        String func = m.func() == null ? "" : m.func().toUpperCase();
        if (!AGG_FUNCS.contains(func)) {
            throw new BizException("FILTER_OPERATOR_INVALID", "非法聚合函数: " + m.func());
        }
        if ("__count".equals(m.fieldKey())) {
            if (!"COUNT".equals(func)) {
                throw new BizException("FILTER_OPERATOR_INVALID", "__count 伪字段仅支持 COUNT");
            }
            return "COUNT(*)";
        }
        FieldMeta f = requireActive(m.fieldKey(), ctx.fieldsBy);
        String expr = SqlBuilder.fieldExpr(m.fieldKey(), f);
        return switch (func) {
            case "COUNT" -> "COUNT(" + expr + ")";
            case "COUNT_DISTINCT" -> "COUNT(DISTINCT " + expr + ")";
            case "SUM", "AVG" -> {
                if (!"number".equals(f.fieldType()) && !"computed".equals(f.fieldType())) {
                    throw new BizException("FILTER_OPERATOR_INVALID",
                            func + " 须数值字段: " + m.fieldKey());
                }
                yield func + "(" + expr + ")";
            }
            default -> func + "(" + expr + ")";
        };
    }

    private static FieldMeta requireActive(String fieldKey, Map<String, FieldMeta> fieldsBy) {
        FieldMeta f = fieldsBy.get(fieldKey);
        if (f == null || !f.active()) {
            throw new BizException("FIELD_DELETED", "字段不可用: " + fieldKey);
        }
        return f;
    }

    private static List<Object> concat(List<Object> a, List<Object> b) {
        List<Object> result = new ArrayList<>(a);
        result.addAll(b);
        return result;
    }
}
