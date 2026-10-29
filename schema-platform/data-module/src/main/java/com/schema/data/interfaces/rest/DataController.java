package com.schema.data.interfaces.rest;

import com.schema.data.application.DynamicQueryEngine;
import com.schema.data.domain.engine.AggregateBuilder.AggMeasure;
import com.schema.data.domain.engine.AggregateBuilder.AggRequest;
import com.schema.data.domain.engine.SqlBuilder.QueryRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 统一 CRUD 协议接口（02BE 附录 A.1-A.4）。
 * 运行时预览态可读（PREVIEW_ALLOWED_PATHS 含 /api/data 前缀白名单由过滤器层管理）。
 */
@RestController
public class DataController {

    private final DynamicQueryEngine engine;

    public DataController(DynamicQueryEngine engine) {
        this.engine = engine;
    }

    // ---------- A.1 列表查询 ----------

    @GetMapping("/api/data/{modelId}")
    public Map<String, Object> query(@PathVariable long modelId,
            @RequestParam(required = false) String filter,
            @RequestParam(required = false) String sort,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) List<String> fields,
            @RequestParam(defaultValue = "1") int relationDepth,
            @RequestParam(defaultValue = "false") boolean includeDeletedFields) {
        QueryRequest req = new QueryRequest(modelId,
                parseJson(filter, "filter"),
                parseSorts(sort),
                page, size, fields, relationDepth, includeDeletedFields);
        return engine.query(req);
    }

    // ---------- A.1 详情 ----------

    @GetMapping("/api/data/{modelId}/{id}")
    public Map<String, Object> getById(@PathVariable long modelId, @PathVariable long id) {
        return engine.getById(modelId, id);
    }

    // ---------- A.1 创建 ----------

    @PostMapping("/api/data/{modelId}")
    public ResponseEntity<Map<String, Object>> create(@PathVariable long modelId,
            @RequestBody Map<String, Object> data) {
        Map<String, Object> resp = engine.create(modelId, data);
        return ResponseEntity.status(HttpStatus.CREATED).body(resp);
    }

    // ---------- A.1 更新 ----------

    @PutMapping("/api/data/{modelId}/{id}")
    public Map<String, Object> update(@PathVariable long modelId, @PathVariable long id,
            @RequestBody Map<String, Object> data) {
        engine.update(modelId, id, data);
        return Map.of();
    }

    // ---------- A.1 逻辑删除 ----------

    @DeleteMapping("/api/data/{modelId}/{id}")
    public Map<String, Object> delete(@PathVariable long modelId, @PathVariable long id) {
        engine.delete(modelId, id);
        return Map.of();
    }

    // ---------- A.3 唯一性校验 ----------

    @PostMapping("/api/data/{modelId}/unique-check")
    public Map<String, Object> uniqueCheck(@PathVariable long modelId,
            @RequestBody Map<String, Object> body) {
        String fieldKey = (String) body.get("fieldKey");
        Object value = body.get("value");
        Long excludeId = body.get("excludeId") instanceof Number n ? n.longValue() : null;
        return engine.uniqueCheck(modelId, fieldKey, value, excludeId);
    }

    // ---------- A.4 聚合 ----------

    @PostMapping("/api/data/{modelId}/aggregate")
    public Map<String, Object> aggregate(@PathVariable long modelId,
            @RequestBody Map<String, Object> body) {
        List<AggMeasure> measures = new ArrayList<>();
        if (body.get("measures") instanceof List<?> list) {
            for (Object m : list) {
                if (m instanceof Map<?, ?> mm) {
                    measures.add(new AggMeasure(String.valueOf(mm.get("fieldKey")),
                            String.valueOf(mm.get("func"))));
                }
            }
        }
        String groupField = body.get("group") instanceof Map<?, ?> g
                && g.get("fieldKey") != null ? String.valueOf(g.get("fieldKey")) : null;
        Integer topN = body.get("group") instanceof Map<?, ?> g2
                && g2.get("topN") instanceof Number n ? n.intValue() : null;
        String bucketField = body.get("timeBucket") instanceof Map<?, ?> tb
                && tb.get("fieldKey") != null ? String.valueOf(tb.get("fieldKey")) : null;
        String interval = body.get("timeBucket") instanceof Map<?, ?> tb2
                && tb2.get("interval") != null ? String.valueOf(tb2.get("interval")) : null;

        @SuppressWarnings("unchecked")
        Map<String, Object> filter = (Map<String, Object>) body.get("filter");
        AggRequest req = new AggRequest(modelId, filter, measures, groupField, topN,
                bucketField, interval);
        return engine.aggregate(req);
    }

    // ---------- 参数解析 ----------

    private static Map<String, Object> parseJson(String raw, String name) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return com.schema.platform.common.json.Json.readMap(raw);
        } catch (Exception e) {
            throw new com.schema.platform.common.web.BizException(
                    "FILTER_OPERATOR_INVALID", name + " 参数非法 JSON");
        }
    }

    private static List<Map<String, Object>> parseSorts(String raw) {
        if (raw == null || raw.isBlank()) {
            return List.of();
        }
        try {
            Object parsed = com.schema.platform.common.json.Json.read(raw, Object.class);
            if (parsed instanceof List<?> list) {
                List<Map<String, Object>> result = new ArrayList<>();
                for (Object o : list) {
                    if (o instanceof Map<?, ?> m) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> sm = (Map<String, Object>) m;
                        result.add(sm);
                    }
                }
                return result;
            }
        } catch (Exception ignored) {
            // 非法排序参数：空集处理（后续白名单校验兜底）
        }
        return List.of();
    }
}
