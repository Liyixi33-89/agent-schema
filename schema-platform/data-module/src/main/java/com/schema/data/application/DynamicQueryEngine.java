package com.schema.data.application;

import com.schema.data.domain.engine.AggregateBuilder;
import com.schema.data.domain.engine.AggregateBuilder.AggMeasure;
import com.schema.data.domain.engine.AggregateBuilder.AggRequest;
import com.schema.data.domain.engine.ReadCompatibility;
import com.schema.data.domain.engine.ScopeResolver;
import com.schema.data.domain.engine.SqlBuilder;
import com.schema.data.domain.engine.SqlBuilder.QueryRequest;
import com.schema.data.domain.engine.WriteValidator;
import com.schema.data.domain.repository.DataPermissionPort;
import com.schema.data.domain.repository.MetadataPort;
import com.schema.data.domain.repository.MetadataPort.FieldMeta;
import com.schema.data.domain.repository.MetadataPort.ModelMeta;
import com.schema.data.infrastructure.table.PhysicalTableManager;
import com.schema.platform.common.json.Json;
import com.schema.platform.common.tenant.PreviewContext;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
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
 *
 * 安全收口（2026-10-30）：
 * - 字段级权限改为「授权集」语义：未配置 FIELD 行=全可见；已配置=仅授权集可见（03BE §3.4）；
 * - 聚合参数序修正为 tenant → filter → scope（与 SQL 条件段同序）；
 * - 唯一性校验/预检注入行级范围条件（权限外数据存在性不泄露）；
 * - 更新保留历史 JSONB 键（DELETED 字段值不丢——02BE §2.4 键永不移除）；
 * - 预览态写拒绝 + 限页模型范围（PreviewDataGuard——04BE §A.7 数据面）。
 */
@Service
public class DynamicQueryEngine {

    private static final Logger log = LoggerFactory.getLogger(DynamicQueryEngine.class);
    private static final int MAX_SIZE = 200;
    private static final long MAX_OFFSET = 100_000L;
    private static final int MAX_BATCH_ROWS = 500;

    private final JdbcTemplate jdbc;
    private final MetadataPort metadata;
    private final DataPermissionPort permissions;
    private final PhysicalTableManager tables;
    private final PreviewDataGuard previewGuard;
    /** @Lazy 自代理：readOnly 查询事务内的建表/索引收敛必须经代理走 REQUIRES_NEW。 */
    private final DynamicQueryEngine self;

    public DynamicQueryEngine(JdbcTemplate jdbc, MetadataPort metadata,
            DataPermissionPort permissions, PhysicalTableManager tables,
            PreviewDataGuard previewGuard,
            @org.springframework.context.annotation.Lazy DynamicQueryEngine self) {
        this.jdbc = jdbc;
        this.metadata = metadata;
        this.permissions = permissions;
        this.tables = tables;
        this.previewGuard = previewGuard;
        this.self = self;
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
        // 写拒绝判定前置于模型范围（写操作预览态本就全禁——先给明确错误码）
        previewGuard.assertWriteAllowed(PreviewContext.isPreview(), PreviewContext.allowRealWrite());
        EngineContext ctx = prepare(modelId, null, false);
        String table = ctx.table;
        Map<String, Object> cleaned = writeNormalize(data, ctx, true);
        applyComputed(ctx, cleaned);
        validateWrites(ctx, cleaned);
        long id = nextId();

        // 唯一性应用层预检（含行级范围条件——权限外数据存在性不泄露；真唯一靠部分索引）
        checkUnique(table, ctx, cleaned, null);

        try {
            jdbc.update("INSERT INTO " + table + " (id, tenant_id, data, schema_version, created_by, "
                            + "created_at) VALUES (?, ?, ?::jsonb, ?, ?, now())",
                    id, ctx.tenant.tenantId(), Json.write(cleaned), ctx.model.currentVersion(),
                    ctx.tenant.operatorId());
        } catch (org.springframework.dao.DuplicateKeyException e) {
            // 并发写入撞 UNIQUE 索引（预检 TOCTOU 窗口）——索引为唯一性唯一真源
            throw new BizException("VALIDATION_FAILED", "唯一字段重复（并发冲突）");
        }
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("id", id);
        return resp;
    }

    // ---------- §3.1 update ----------

    @Transactional
    public void update(long modelId, long id, Map<String, Object> data) {
        previewGuard.assertWriteAllowed(PreviewContext.isPreview(), PreviewContext.allowRealWrite());
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
        // 更新场景同等 required 校验：显式传 null/空串清空必填字段 → 拒绝
        enforceRequiredOnUpdate(ctx, data);
        // 写入集 = 本次提交规范化（不可编辑剔除、类型校验、未知字段剔除）
        Map<String, Object> cleaned = writeNormalize(updateBaseline(currentData, data, ctx), ctx, false);
        applyComputed(ctx, cleaned);
        validateWrites(ctx, cleaned);
        checkUnique(table, ctx, cleaned, id);
        // JSONB merge 写入（02BE §2.4 历史键永不移除）：只覆盖待写键，
        // DELETED 字段历史键与库中其它未知键原样保留——不整体覆写 data
        jdbc.update("UPDATE " + table + " SET data = data || ?::jsonb, schema_version = ?, "
                        + "updated_at = now() WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
                Json.write(cleaned), ctx.model.currentVersion(), id, ctx.tenant.tenantId());
    }

    // ---------- §3.1 delete（逻辑删除） ----------

    @Transactional
    public void delete(long modelId, long id) {
        previewGuard.assertWriteAllowed(PreviewContext.isPreview(), PreviewContext.allowRealWrite());
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

    // ---------- A.1 批量 upsert（02BE §6：单批 ≤500 行，keyField 冲突更新） ----------

    @Transactional
    public Map<String, Object> batchUpsert(long modelId, List<Map<String, Object>> rows,
            String keyField) {
        previewGuard.assertWriteAllowed(PreviewContext.isPreview(), PreviewContext.allowRealWrite());
        EngineContext ctx = prepare(modelId, null, false);
        if (rows == null || rows.isEmpty()) {
            return Map.of("inserted", 0, "updated", 0, "failed", List.of());
        }
        if (rows.size() > MAX_BATCH_ROWS) {
            throw new BizException("BATCH_TOO_LARGE", "单批上限 " + MAX_BATCH_ROWS + " 行");
        }
        FieldMeta keyMeta = requireActive(keyField, ctx.fieldsBy);
        if (!keyMeta.uniqueFlag()) {
            throw new BizException("VALIDATION_FAILED", "keyField 须为唯一字段: " + keyField);
        }

        int inserted = 0;
        int updated = 0;
        List<Map<String, Object>> failed = new ArrayList<>();
        for (int i = 0; i < rows.size(); i++) {
            Map<String, Object> row = rows.get(i);
            try {
                Object keyValue = row == null ? null : row.get(keyField);
                if (keyValue == null || String.valueOf(keyValue).isBlank()) {
                    throw new BizException("VALIDATION_FAILED", "keyField 值缺失: " + keyField);
                }
                // 按 keyField 查既有行（租户 + 未删除 + 行级范围内）
                String keyExpr = SqlBuilder.fieldExpr(keyField, keyMeta);
                String findSql = "SELECT id, data FROM " + ctx.table
                        + " WHERE tenant_id = ? AND deleted_at IS NULL AND " + keyExpr + " = ?"
                        + " AND (" + ctx.scopeSql + ")";
                List<Object> findParams = new ArrayList<>(
                        List.of(ctx.tenant.tenantId(), keyValue));
                findParams.addAll(ctx.scopeParams);
                List<Map<String, Object>> hits = jdbc.queryForList(findSql, findParams.toArray());
                if (hits.isEmpty()) {
                    // 保存点隔离（2026-10-30 三轮收口）：PG 唯一冲突会中止整个事务，
                    // 后续行全部失败——每行包保存点，冲突回滚到保存点后继续处理。
                    Map<String, Object> resp = inSavepoint(() -> doCreate(ctx, row));
                    inserted++;
                    resp.put("_index", i);
                } else {
                    long existId = ((Number) hits.get(0).get("id")).longValue();
                    inSavepoint(() -> {
                        doUpdate(ctx, existId, hits.get(0), row);
                        return null;
                    });
                    updated++;
                }
            } catch (BizException e) {
                Map<String, Object> fail = new LinkedHashMap<>();
                fail.put("index", i);
                fail.put("reason", e.code() + ": " + e.getMessage());
                failed.add(fail);
            } catch (org.springframework.dao.DuplicateKeyException e) {
                // 并发同键撞 UNIQUE 部分索引（应用层预检 TOCTOU 窗口被索引兜住）：
                // 冲突已由保存点回滚隔离——事务未中止，其余行继续
                Map<String, Object> fail = new LinkedHashMap<>();
                fail.put("index", i);
                fail.put("reason", "VALIDATION_FAILED: 唯一字段冲突（并发写入）");
                failed.add(fail);
            }
        }
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("inserted", inserted);
        resp.put("updated", updated);
        resp.put("failed", failed);
        return resp;
    }

    /** create 的可复用内核（batch 复用——外层已在事务内）。 */
    private Map<String, Object> doCreate(EngineContext ctx, Map<String, Object> data) {
        String table = ctx.table;
        Map<String, Object> cleaned = writeNormalize(data, ctx, true);
        applyComputed(ctx, cleaned);
        validateWrites(ctx, cleaned);
        long id = nextId();
        checkUnique(table, ctx, cleaned, null);
        jdbc.update("INSERT INTO " + table + " (id, tenant_id, data, schema_version, created_by, "
                        + "created_at) VALUES (?, ?, ?::jsonb, ?, ?, now())",
                id, ctx.tenant.tenantId(), Json.write(cleaned), ctx.model.currentVersion(),
                ctx.tenant.operatorId());
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("id", id);
        return resp;
    }

    /**
     * 保存点执行器（batch 行级隔离，2026-10-30 三轮收口）：
     * PG 异常（唯一冲突等）会中止整个外层事务，后续语句必报 25P02。
     * 每行包 SAVEPOINT/ROLLBACK TO SAVEPOINT——冲突行回滚后事务可继续。
     * 无事务上下文时（防御）直接执行。
     */
    private <T> T inSavepoint(java.util.function.Supplier<T> body) {
        if (!org.springframework.transaction.support.TransactionSynchronizationManager
                .isActualTransactionActive()) {
            return body.get();
        }
        String spName = "batch_sp_" + SAVEPOINT_SEQ.incrementAndGet();
        try {
            jdbc.execute((java.sql.Connection con) -> {
                con.createStatement().execute("SAVEPOINT " + spName);
                return null;
            });
            T result = body.get();
            jdbc.execute((java.sql.Connection con) -> {
                con.createStatement().execute("RELEASE SAVEPOINT " + spName);
                return null;
            });
            return result;
        } catch (RuntimeException e) {
            jdbc.execute((java.sql.Connection con) -> {
                con.createStatement().execute("ROLLBACK TO SAVEPOINT " + spName);
                return null;
            });
            throw e;
        }
    }

    private static final java.util.concurrent.atomic.AtomicLong SAVEPOINT_SEQ =
            new java.util.concurrent.atomic.AtomicLong();

    /** update 的可复用内核（batch 复用——传入已查出的既有行避免二次查询）。 */
    private void doUpdate(EngineContext ctx, long id, Map<String, Object> existingRow,
            Map<String, Object> data) {
        String table = ctx.table;
        Map<String, Object> currentData = Json.readMap(String.valueOf(existingRow.get("data")));
        if (currentData == null) {
            currentData = new LinkedHashMap<>();
        }
        enforceRequiredOnUpdate(ctx, data);
        Map<String, Object> cleaned = writeNormalize(updateBaseline(currentData, data, ctx), ctx, false);
        applyComputed(ctx, cleaned);
        validateWrites(ctx, cleaned);
        checkUnique(table, ctx, cleaned, id);
        // JSONB merge 写入：历史键永不移除（02BE §2.4）
        jdbc.update("UPDATE " + table + " SET data = data || ?::jsonb, schema_version = ?, "
                        + "updated_at = now() WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL",
                Json.write(cleaned), ctx.model.currentVersion(), id, ctx.tenant.tenantId());
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
        // 行级范围条件注入：权限外数据的唯一性冲突不暴露（02BE §A.6 不给线索口径）
        String sql = "SELECT COUNT(*) FROM " + ctx.table
                + " WHERE tenant_id = ? AND deleted_at IS NULL AND " + expr + " = ?"
                + (excludeId == null ? "" : " AND id <> ?")
                + " AND (" + ctx.scopeSql + ")";
        List<Object> params = new ArrayList<>(List.of(ctx.tenant.tenantId(), value));
        if (excludeId != null) {
            params.add(excludeId);
        }
        params.addAll(ctx.scopeParams);
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
        // 桶跨度防护（02BE §3.6 第 7 步）：无限桶拒绝
        AggregateBuilder.guardBucketSpan(ctx.model, req.bucketField(), req.bucketInterval(),
                req.filter());
        // 参数序修正（2026-10-30）：SQL 条件段顺序 tenant → filter → scope，
        // 参数同序追加——此前 scope 在 filter 前导致带 SELF + 过滤条件时错位
        List<Object> params = new ArrayList<>(List.of(ctx.tenant.tenantId()));

        StringBuilder filterPart = new StringBuilder();
        SqlBuilder.buildCondition(req.filter(), ctx.fieldsBy, params, filterPart, null);

        StringBuilder where = new StringBuilder(" WHERE tenant_id = ? AND deleted_at IS NULL");
        if (!filterPart.isEmpty()) {
            where.append(" AND (").append(filterPart).append(")");
        }
        where.append(" AND (").append(ctx.scopeSql).append(")");
        params.addAll(ctx.scopeParams);

        // 度量执行路径校验（02BE §3.6：1-5 个；函数白名单；__count 仅 COUNT；SUM/AVG 须数值）
        if (measures.isEmpty() || measures.size() > 5) {
            throw new BizException("FILTER_OPERATOR_INVALID", "度量数量须为 1-5");
        }
        List<String> selects = new ArrayList<>();
        List<String> groups = new ArrayList<>();
        boolean hasBucket = false;
        boolean hasGroup = false;
        if (req.bucketField() != null) {
            FieldMeta bf = requireActive(req.bucketField(), ctx.fieldsBy);
            if (!"date".equals(bf.fieldType())) {
                throw new BizException("FILTER_OPERATOR_INVALID",
                        "时间桶字段须为 date 类型: " + req.bucketField());
            }
            // 时间桶间隔白名单（执行路径校验——永不拼入未校验文本）
            String interval = req.bucketInterval() == null ? ""
                    : req.bucketInterval().toUpperCase();
            if (!AggregateBuilder.BUCKET_INTERVALS.contains(interval)) {
                throw new BizException("FILTER_OPERATOR_INVALID", "非法分桶间隔: " + req.bucketInterval());
            }
            String trunc = "date_trunc('" + interval.toLowerCase() + "', "
                    + SqlBuilder.fieldExpr(req.bucketField(), bf) + ")";
            selects.add(trunc + " AS bucket");
            groups.add(trunc);
            hasBucket = true;
        }
        if (req.groupField() != null) {
            FieldMeta gf = requireActive(req.groupField(), ctx.fieldsBy);
            String expr = SqlBuilder.fieldExpr(req.groupField(), gf);
            selects.add(expr + " AS dimension");
            groups.add(expr);
            hasGroup = true;
        }
        for (int i = 0; i < measures.size(); i++) {
            selects.add(measureExpr(measures.get(i), ctx) + " AS m" + i);
        }

        String sql;
        if (groups.isEmpty()) {
            sql = "SELECT " + String.join(", ", selects) + " FROM " + ctx.table + where;
        } else if (hasBucket && !hasGroup) {
            // 纯时间桶：不按度量 topN 截断——按桶时序全量返回（跨度护栏已限桶数 ≤1000）
            sql = "SELECT " + String.join(", ", selects)
                    + " FROM " + ctx.table + where
                    + " GROUP BY " + String.join(", ", groups)
                    + " ORDER BY bucket ASC";
        } else if (hasBucket && hasGroup) {
            // 桶+组组合（2026-10-30 三轮收口）：桶数已被护栏限 ≤1000，组维度按 topN 截断
            // 但必须按「组内度量合计」选组而非全局排序截断——全局 LIMIT 会砍掉整组的时间序列。
            int topN = req.groupTopN() == null ? 10 : Math.min(Math.max(req.groupTopN(), 1), 50);
            sql = "SELECT * FROM (SELECT " + String.join(", ", selects)
                    + " FROM " + ctx.table + where
                    + " GROUP BY " + String.join(", ", groups) + ") buckets_all "
                    + "WHERE dimension IN (SELECT dimension FROM (SELECT dimension, SUM(m0) s "
                    + "FROM (SELECT " + String.join(", ", selects)
                    + " FROM " + ctx.table + where
                    + " GROUP BY " + String.join(", ", groups) + ") g "
                    + "GROUP BY dimension ORDER BY s DESC LIMIT " + topN + ") top_dims) "
                    + "ORDER BY bucket ASC, dimension ASC";
        } else {
            int topN = req.groupTopN() == null ? 10 : Math.min(Math.max(req.groupTopN(), 1), 50);
            sql = "SELECT * FROM (SELECT " + String.join(", ", selects)
                    + " FROM " + ctx.table + where
                    + " GROUP BY " + String.join(", ", groups)
                    + " ORDER BY m0 DESC LIMIT " + topN + ") agg_order";
        }
        // 超时熔断（02BE §3.6 第 7 步，2026-10-30 二轮修正）：
        // 不再改共享 JdbcTemplate 全局超时（并发请求互相污染）；改用语句级设置。
        org.springframework.jdbc.core.PreparedStatementCreator psc = con -> {
            var stmt = con.prepareStatement(sql);
            for (int i = 0; i < params.size(); i++) {
                stmt.setObject(i + 1, params.get(i));
            }
            stmt.setQueryTimeout(AggregateBuilder.AGG_TIMEOUT_SECONDS);
            return stmt;
        };
        org.springframework.jdbc.core.RowMapper<Map<String, Object>> rowMapper = (rs, rowNum) -> {
            Map<String, Object> row = new LinkedHashMap<>();
            int cols = rs.getMetaData().getColumnCount();
            for (int i = 1; i <= cols; i++) {
                row.put(rs.getMetaData().getColumnLabel(i), rs.getObject(i));
            }
            return row;
        };
        try {
            List<Map<String, Object>> raw = new ArrayList<>(
                    jdbc.query(psc, rowMapper));
            Map<String, Object> resp = new LinkedHashMap<>();
            resp.put("rows", AggregateBuilder.toRows(raw, measures, hasBucket, hasGroup));
            return resp;
        } catch (org.springframework.dao.QueryTimeoutException e) {
            throw new BizException("AGG_TIMEOUT", "聚合查询超时熔断（超过 "
                    + AggregateBuilder.AGG_TIMEOUT_SECONDS + "s）——请缩小过滤范围或加索引");
        }
    }

    // ---------- 建表入口（M2 建模时联动） ----------

    /** 建表 + 全量索引收敛（幂等——建表/提升列/唯一表达式索引一次到位）。 */
    @Transactional
    public void ensurePhysicalTable(long tenantId, long modelId) {
        List<FieldMeta> fields = metadata.findFields(tenantId, modelId);
        List<Map<String, Object>> indexed = new ArrayList<>();
        for (FieldMeta f : fields) {
            if (f.indexed() && f.active()) {
                Map<String, Object> m = new HashMap<>();
                m.put("fieldKey", f.fieldKey());
                m.put("fieldType", f.fieldType());
                m.put("uniqueFlag", f.uniqueFlag());
                indexed.add(m);
            }
        }
        tables.ensureTable(tenantId, modelId, indexed);
        // 唯一字段表达式 UNIQUE 索引兜底（不依赖提升列路径——建模期 uniqueFlag 即生效）
        for (FieldMeta f : fields) {
            if (f.uniqueFlag() && f.active()) {
                tables.ensureUniqueExprIndex(tenantId, modelId, f.fieldKey());
            }
        }
    }

    /**
     * 独立可写事务建表收敛（自代理调用点）：
     * readOnly 查询事务内触发建表/DDL 时挂起外层事务开新可写事务（DDL 与登记行原子）。
     * 水位更新同事务提交——readOnly 外层不再执行写。
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void ensurePhysicalTableInNewTx(long tenantId, long modelId, int syncedVersion) {
        ensurePhysicalTable(tenantId, modelId);
        jdbc.update("UPDATE data_physical_table SET synced_version=? WHERE model_id=? AND tenant_id=?",
                syncedVersion, modelId, tenantId);
    }

    /** schema 版本水位收敛：版本落后时幂等补索引（建表后建模变更触发——写路径前置一次性）。 */
    private void syncIndexesIfNeeded(EngineContext ctx) {
        Integer synced = jdbc.query(
                "SELECT synced_version FROM data_physical_table WHERE model_id=? AND tenant_id=?",
                (rs, i) -> rs.getInt(1), ctx.model.id(), ctx.tenant.tenantId()).stream()
                .findFirst().orElse(null);
        int current = ctx.model.currentVersion();
        if (synced == null || synced >= current) {
            return;
        }
        self.ensurePhysicalTableInNewTx(ctx.tenant.tenantId(), ctx.model.id(), current);
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
        // 预览数据面模型范围（04BE §A.7：限页→页绑定模型∪快照引用；应用级→应用内模型）
        previewGuard.assertModelInPreviewScope(PreviewContext.isPreview(),
                PreviewContext.appId(), PreviewContext.pageId(),
                tenant.tenantId(), modelId);
        if (!tables.tableExists(modelId)) {
            // 未建物理表：建表幂等（首个数据请求触发——建模后未手动建表的窗口期兜底）。
            // readOnly 查询事务不可执行 DDL——走自代理 REQUIRES_NEW 独立可写事务
            self.ensurePhysicalTableInNewTx(tenant.tenantId(), modelId, model.currentVersion());
        } else {
            // schema 版本水位收敛（2026-10-30 二轮收口）：建模变更后首个请求
            // 幂等补建唯一索引/提升列——唯一约束不再依赖「建模时刚好建表」
            syncIndexesIfNeeded(new EngineContext(tenant, model, Map.of(), List.of(), List.of(),
                    PhysicalTableManager.tableName(modelId), "1=0", List.of()));
        }
        List<FieldMeta> allFields = metadata.findFields(tenant.tenantId(), modelId);
        List<FieldMeta> activeFields = activeOf(allFields);
        // 字段级权限收敛（03BE §3.4 授权集语义，2026-10-30 二轮收口）：
        // 可见字段集 = 未配置全 ACTIVE；已配置仅授权集。fieldsBy 只收录可见字段——
        // 过滤/排序/聚合度量与维度/唯一预检/写入校验全部以可见集为白名单，
        // 不可见字段不可读、不可作为过滤条件（防推断）、不可参与聚合（防沙数外泄）。
        List<FieldMeta> visibleActive = visibleFields(tenant.tenantId(),
                tenant.operatorId(), model.id(), activeFields);
        Map<String, FieldMeta> fieldsBy = new HashMap<>();
        for (FieldMeta f : visibleActive) {
            fieldsBy.put(f.fieldKey(), f);
        }
        // includeDeletedFields 白名单：仅管理员，记审计（02BE §3.1/A.2）
        if (includeDeletedFields) {
            log.info("includeDeletedFields 审计: tenant={} operator={} model={}",
                    tenant.tenantId(), tenant.operatorId(), modelId);
        }

        // 行级权限解析（03BE §3.3）——用户属性取真实部门上下文（不再占位 0/null）
        List<Object> scopeParams = new ArrayList<>();
        String scopeSql;
        if (tenant.operatorId() <= 0) {
            scopeSql = "1 = 0"; // 无操作者上下文 = 默认拒绝
        } else {
            List<DataPermissionPort.ScopeCondition> scopes =
                    permissions.resolveScopes(tenant.tenantId(), tenant.operatorId(), modelId);
            DataPermissionPort.UserAttrs attrs = permissions.resolveUserAttrs(
                    tenant.tenantId(), tenant.operatorId());
            scopeSql = ScopeResolver.resolve(scopes, tenant.operatorId(), attrs,
                    tenant.tenantId(), scopeParams);
        }
        return new EngineContext(tenant, model, fieldsBy,
                activeFields, visibleActive, PhysicalTableManager.tableName(modelId),
                scopeSql, scopeParams);
    }

    private record EngineContext(TenantInfo tenant, ModelMeta model,
            Map<String, FieldMeta> fieldsBy, List<FieldMeta> activeFields,
            List<FieldMeta> visibleFields, String table, String scopeSql, List<Object> scopeParams) {
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

    /**
     * 可见字段（03BE §3.4 授权集语义，2026-10-30 修正）：
     * - 模型未配置 FIELD 权限 → 全 ACTIVE 字段可见（不锁死未配置模型）；
     * - 已配置 → 仅授权集内可见（"*" = 整模型字段全授权）；不可见字段物理剔除。
     */
    private List<FieldMeta> visibleFields(EngineContext ctx) {
        return ctx.visibleFields;
    }

    /** 权限解析独立入口（prepare 阶段调用——上下文未建时使用）。 */
    private List<FieldMeta> visibleFields(long tenantId, long operatorId, long modelId,
            List<FieldMeta> activeFields) {
        boolean configured = permissions.hasFieldPermConfig(tenantId, modelId);
        if (!configured) {
            return activeFields;
        }
        Set<String> granted = permissions.visibleFields(tenantId, operatorId, modelId);
        List<FieldMeta> result = new ArrayList<>();
        for (FieldMeta f : activeFields) {
            if (granted.contains("*") || granted.contains(f.fieldKey())) {
                result.add(f);
            }
        }
        return result;
    }

    /** 可编辑字段集（语义同 visibleFields——未配置全可编辑；权限解析独立入口供写入侧消费）。 */
    private Set<String> uneditableKeys(EngineContext ctx) {
        boolean configured = permissions.hasFieldPermConfig(ctx.tenant.tenantId(),
                ctx.model.id());
        if (!configured) {
            return Set.of();
        }
        Set<String> granted = permissions.editableFields(ctx.tenant.tenantId(),
                ctx.tenant.operatorId(), ctx.model.id());
        if (granted.contains("*")) {
            return Set.of();
        }
        // 不可编辑 = ACTIVE 字段集 − 授权集
        Set<String> uneditable = new HashSet<>();
        for (FieldMeta f : ctx.activeFields) {
            if (!granted.contains(f.fieldKey())) {
                uneditable.add(f.fieldKey());
            }
        }
        return uneditable;
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

    /**
     * computed 字段重算（02BE §3.4 第 2 步，2026-10-30 接线）：
     * PERSISTED 计算字段按表达式对「待写行值」重算后写入——用户传入的计算字段值被覆盖
     * （计算字段不可伪造）；READ_TIME 类型已在 writeNormalize 剔除。
     * 求值失败（编译错/字段缺失）抛 VALIDATION_FAILED——不给「配置坏=放行」的旁路；
     * 依赖链成环在建模侧已拦（CIRCULAR_DEPENDENCY），此处按拓扑序两轮迭代兜底。
     */
    private void applyComputed(EngineContext ctx, Map<String, Object> cleaned) {
        List<FieldMeta> computedFields = new ArrayList<>();
        for (FieldMeta f : ctx.activeFields) {
            if ("computed".equals(f.fieldType()) && f.computedConfig() != null
                    && "PERSISTED".equals(String.valueOf(f.computedConfig().get("persistMode")))) {
                computedFields.add(f);
            }
        }
        if (computedFields.isEmpty()) {
            return;
        }
        // 拓扑序：依赖其它 computed 的计算字段后算——两轮迭代兜底（环已被建模侧拦截）
        for (int round = 0; round < 2; round++) {
            for (FieldMeta f : computedFields) {
                Object exprObj = f.computedConfig().get("expr");
                String expr = exprObj instanceof String s ? s
                        : exprObj instanceof Map<?, ?> eb && eb.get("source") instanceof String src
                                ? src : null;
                if (expr == null || expr.isBlank()) {
                    throw new BizException("VALIDATION_FAILED",
                            "计算字段表达式缺失: " + f.fieldKey());
                }
                try {
                    com.schema.protocol.expr.ExprEngine.Node ast =
                            com.schema.protocol.expr.ExprEngine.compile(expr);
                    Map<String, Object> scope = new java.util.HashMap<>(cleaned);
                    var result = com.schema.protocol.expr.ExprEngine.evaluate(ast, scope);
                    if (result.error() != null) {
                        throw new BizException("VALIDATION_FAILED", "计算字段求值失败: "
                                + f.fieldKey() + " (" + result.error().code() + ")");
                    }
                    cleaned.put(f.fieldKey(), result.value());
                } catch (BizException e) {
                    throw e;
                } catch (Exception e) {
                    throw new BizException("VALIDATION_FAILED",
                            "计算字段配置非法: " + f.fieldKey());
                }
            }
        }
    }

    /**
     * 写入规范化（02BE §3.4 第 1 步）：
     * 未知字段剔除 + required 校验 + 不可编辑保留原值（不丢键）+ computed READ_TIME 剔除。
     * 更新场景 isCreate=false：输入为「库中现值 ∪ 本次提交」合并集——
     * DELETED 字段历史键保留在合并集中（writeNormalize 只按 ACTIVE 集输出清洗结果，
     * 历史键由调用方 mergeForUpdate 保留——见 update/doUpdate）。
     */
    private Map<String, Object> writeNormalize(Map<String, Object> data, EngineContext ctx,
            boolean isCreate) {
        if (data == null) {
            data = new LinkedHashMap<>();
        }
        Map<String, Object> cleaned = new LinkedHashMap<>();
        Set<String> uneditable = uneditableKeys(ctx);
        List<String> missing = new ArrayList<>();
        for (FieldMeta f : ctx.activeFields) {
            if ("computed".equals(f.fieldType())) {
                // computed 字段不可直接写入；PERSISTED 由 applyComputed 重算覆盖
                // （合并集含库中现值——重算输入完整）；READ_TIME 剔除
                if ("PERSISTED".equals(f.computedConfig() == null ? null
                        : String.valueOf(f.computedConfig().get("persistMode")))) {
                    cleaned.put(f.fieldKey(),
                            data.containsKey(f.fieldKey()) ? data.get(f.fieldKey()) : null);
                } else if (isCreate && f.defaultValue() != null) {
                    cleaned.put(f.fieldKey(), f.defaultValue());
                }
                continue;
            }
            if (data.containsKey(f.fieldKey())) {
                if (uneditable.contains(f.fieldKey())) {
                    // 不可编辑：保留现值（键不丢——不可编辑 ≠ 可删值；create 场景无现值即剔除）
                    if (!isCreate) {
                        cleaned.put(f.fieldKey(), data.get(f.fieldKey()));
                    }
                    continue;
                }
                Object v = data.get(f.fieldKey());
                if (f.required() && isNullOrBlank(v)) {
                    if (isCreate) {
                        missing.add(f.fieldKey());
                        continue;
                    }
                    cleaned.put(f.fieldKey(), v); // 更新清空非必填语义走 validateWrites
                    continue;
                }
                cleaned.put(f.fieldKey(), v);
            } else if (isCreate && f.required()) {
                if (f.defaultValue() != null) {
                    cleaned.put(f.fieldKey(), f.defaultValue());
                } else {
                    missing.add(f.fieldKey());
                }
            } else if (isCreate && f.defaultValue() != null) {
                cleaned.put(f.fieldKey(), f.defaultValue());
            }
        }
        if (!missing.isEmpty()) {
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("fields", missing);
            throw new BizException("VALIDATION_FAILED", "必填字段缺失: " + String.join(", ", missing),
                    detail);
        }
        return cleaned;
    }

    /** 更新场景 required 口径（2026-10-30 收口）：显式传 null/空串清空必填字段 → 拒绝。 */
    private static void enforceRequiredOnUpdate(EngineContext ctx, Map<String, Object> incoming) {
        if (incoming == null) {
            return;
        }
        List<String> missing = new ArrayList<>();
        for (FieldMeta f : ctx.activeFields) {
            if (f.required() && incoming.containsKey(f.fieldKey())
                    && isNullOrBlank(incoming.get(f.fieldKey()))) {
                missing.add(f.fieldKey());
            }
        }
        if (!missing.isEmpty()) {
            Map<String, Object> detail = new LinkedHashMap<>();
            detail.put("fields", missing);
            throw new BizException("VALIDATION_FAILED",
                    "必填字段不可清空: " + String.join(", ", missing), detail);
        }
    }

    private static boolean isNullOrBlank(Object v) {
        return v == null || (v instanceof String s && s.isBlank());
    }

    /**
     * 写入值校验链（02BE §3.4 第 1 步：类型/长度/正则/范围/枚举/relation 存在性）。
     * relation 目标存在性批量查询防 N+1（02BE §6 DataLoader 同思路）。
     */
    private void validateWrites(EngineContext ctx, Map<String, Object> cleaned) {
        Map<String, String> errors = new LinkedHashMap<>();
        // 批量收集 relation 目标存在性入参
        Map<String, List<Object>> relationChecks = WriteValidator.collectRelationChecks(
                ctx.activeFields, cleaned);
        Map<String, Set<Object>> existingTargets = new HashMap<>();
        for (var entry : relationChecks.entrySet()) {
            String targetModelKey = entry.getKey();
            List<Object> ids = entry.getValue();
            try {
                Long targetId = Long.parseLong(targetModelKey);
                String targetTable = PhysicalTableManager.tableName(targetId);
                if (!tables.tableExists(targetId)) {
                    for (Object id : ids) {
                        errors.put("relation", "关联目标模型不可用: " + targetModelKey);
                    }
                    continue;
                }
                String placeholders = String.join(",",
                        java.util.Collections.nCopies(ids.size(), "?"));
                List<Object> hits = jdbc.queryForList(
                        "SELECT (data->>'_id') AS rid, id FROM " + targetTable
                                + " WHERE tenant_id=? AND deleted_at IS NULL AND id IN ("
                                + placeholders + ")",
                        concat(List.of(ctx.tenant.tenantId()), ids).toArray())
                        .stream().map(r -> r.get("id")).toList();
                existingTargets.put(targetModelKey, new HashSet<>(hits));
            } catch (NumberFormatException e) {
                errors.put("relation", "关联目标模型标识非法: " + targetModelKey);
            }
        }
        // user/dept 引用存在性批量校验（2026-10-30 接线，02BE §3.4 第 3 步）：
        // sys_user/sys_dept 同库直查（单体阶段；拆分后随端口化改造迁 IAM 端口）。
        Set<Object> existingUsers = referenceHits("sys_user", ctx.tenant.tenantId(),
                ctx.activeFields, cleaned, "user");
        Set<Object> existingDepts = referenceHits("sys_dept", ctx.tenant.tenantId(),
                ctx.activeFields, cleaned, "dept");
        for (FieldMeta f : ctx.activeFields) {
            Object value = cleaned.get(f.fieldKey());
            if (value == null) {
                continue;
            }
            final Set<Object> allowed = existingTargets.get(
                    f.relationConfig() == null ? null
                            : String.valueOf(f.relationConfig().get("targetModelId")));
            Set<Object> refAllowed = "user".equals(f.fieldType()) ? existingUsers
                    : "dept".equals(f.fieldType()) ? existingDepts : null;
            WriteValidator.validate(f, value, errors,
                    (targetModelKey, v) -> {
                        if (refAllowed != null) {
                            return refAllowed.contains(normalizeId(v));
                        }
                        return allowed != null && allowed.contains(normalizeId(v));
                    });
        }
        WriteValidator.throwIfFailed(errors);
    }

    /** user/dept 引用批量存在性命中集（同租户——跨租户引用一律不存在）。 */
    private Set<Object> referenceHits(String table, long tenantId, List<FieldMeta> fields,
            Map<String, Object> cleaned, String fieldType) {
        List<Object> ids = new ArrayList<>();
        for (FieldMeta f : fields) {
            if (fieldType.equals(f.fieldType())) {
                Object v = cleaned.get(f.fieldKey());
                if (v != null && !String.valueOf(v).isBlank()) {
                    ids.add(normalizeId(v));
                }
            }
        }
        if (ids.isEmpty()) {
            return Set.of();
        }
        String placeholders = String.join(",",
                java.util.Collections.nCopies(ids.size(), "?"));
        List<Object> hits = jdbc.queryForList(
                "SELECT id FROM " + table + " WHERE tenant_id=? AND id IN (" + placeholders + ")",
                concat(List.of(tenantId), ids).toArray())
                .stream().map(r -> (Object) ((Number) r.get("id")).longValue()).toList();
        return new HashSet<>(hits);
    }

    /** relation 值规范化：字符串数字与数值主键互认。 */
    private static Object normalizeId(Object v) {
        if (v instanceof Number n) {
            return n.longValue();
        }
        try {
            return Long.parseLong(String.valueOf(v));
        } catch (NumberFormatException e) {
            return v;
        }
    }

    /**
     * 更新合并基线（02BE §2.4 历史键保留）：
     * 基线 = 库中现值 ∪ 本次提交（仅 ACTIVE 且可编辑字段可覆盖）；
     * DELETED 字段历史键留在基线外由 JSONB merge 天然保留（update 不整体覆写 data）。
     */
    private Map<String, Object> updateBaseline(Map<String, Object> current,
            Map<String, Object> incoming, EngineContext ctx) {
        Map<String, Object> merged = new LinkedHashMap<>(current);
        Set<String> uneditable = uneditableKeys(ctx);
        for (FieldMeta f : ctx.activeFields) {
            if (incoming.containsKey(f.fieldKey()) && !uneditable.contains(f.fieldKey())) {
                merged.put(f.fieldKey(), incoming.get(f.fieldKey()));
            }
        }
        return merged;
    }

    /**
     * 唯一应用层预检（02BE §3.4 第 5 步）：
     * 行级范围条件注入（权限外数据冲突不暴露）；真唯一靠提升列 + UNIQUE 部分索引。
     */
    private void checkUnique(String table, EngineContext ctx, Map<String, Object> data, Long excludeId) {
        for (FieldMeta f : ctx.activeFields) {
            if (f.uniqueFlag() && data.containsKey(f.fieldKey())
                    && !isNullOrBlank(data.get(f.fieldKey()))) {
                String expr = SqlBuilder.fieldExpr(f.fieldKey(), f);
                String sql = "SELECT COUNT(*) FROM " + table
                        + " WHERE tenant_id = ? AND deleted_at IS NULL AND " + expr + " = ?"
                        + (excludeId == null ? "" : " AND id <> ?")
                        + " AND (" + ctx.scopeSql + ")";
                List<Object> params = new ArrayList<>(
                        List.of(ctx.tenant.tenantId(), data.get(f.fieldKey())));
                if (excludeId != null) {
                    params.add(excludeId);
                }
                params.addAll(ctx.scopeParams);
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

    /**
     * 可见字段元数据视图（运行时装载面，2026-10-30 补齐）：
     * 字段级权限过滤后的 ACTIVE 集——与查询/写入同源 prepare（预览模型范围 + 授权集语义）。
     * 响应键位与前端 normalizeFields 宽松兼容（fieldKey/label/type/fieldStatus/…）。
     */
    @Transactional(readOnly = true)
    public Map<String, Object> visibleFieldViews(long modelId) {
        EngineContext ctx = prepare(modelId, null, false);
        List<Map<String, Object>> fields = new ArrayList<>();
        for (FieldMeta f : ctx.visibleFields) {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("fieldKey", f.fieldKey());
            v.put("label", f.label());
            v.put("type", f.fieldType());
            v.put("fieldStatus", f.fieldStatus());
            v.put("required", f.required());
            v.put("uniqueFlag", f.uniqueFlag());
            if (f.defaultValue() != null) {
                v.put("defaultValue", f.defaultValue());
            }
            if (f.enumOptions() != null) {
                v.put("enumOptions", f.enumOptions());
            }
            if (f.relationConfig() != null) {
                v.put("relation", f.relationConfig());
            }
            v.put("sortOrder", 0);
            fields.add(v);
        }
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("fields", fields);
        return resp;
    }

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

    /** 雪花替代：随机 63 位正整数（MVP 单机口径；分布式 ID 随拆分引入）。 */
    private static long nextId() {
        return (Math.abs(UUID.randomUUID().getLeastSignificantBits()) >> 1) | 1;
    }
}
