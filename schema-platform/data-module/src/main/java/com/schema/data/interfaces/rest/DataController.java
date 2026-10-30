package com.schema.data.interfaces.rest;

import com.schema.data.application.DynamicQueryEngine;
import com.schema.data.domain.engine.AggregateBuilder;
import com.schema.data.domain.engine.AggregateBuilder.AggMeasure;
import com.schema.data.domain.engine.AggregateBuilder.AggRequest;
import com.schema.data.domain.engine.SqlBuilder.QueryRequest;
import com.schema.platform.common.tenant.PreviewContext;
import com.schema.platform.common.web.BizException;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
 * 统一 CRUD 协议端点（02BE §A.1）。预览态上下文绑定（04BE §A.7 数据面收口）：
 * JwtAuthFilter 传递的请求属性在 Controller 层转 ThreadLocal（引擎/守卫消费），
 * finally 清理与 TenantContext 同纪律。
 */
@RestController
@RequestMapping("/api/data")
public class DataController {

    private static final Logger log = LoggerFactory.getLogger(DataController.class);

    private final DynamicQueryEngine engine;

    public DataController(DynamicQueryEngine engine) {
        this.engine = engine;
    }

    // ---------- 查询 ----------

    @PostMapping("/{modelId}/query")
    public Map<String, Object> query(@PathVariable long modelId,
            @RequestBody(required = false) Map<String, Object> body,
            HttpServletRequest request) {
        return withPreviewContext(request, () -> engine.query(toQueryRequest(modelId, body)));
    }

    @GetMapping("/{modelId}/{id}")
    public Map<String, Object> get(@PathVariable long modelId, @PathVariable long id,
            HttpServletRequest request) {
        return withPreviewContext(request, () -> engine.getById(modelId, id));
    }

    // ---------- 写入 ----------

    @PostMapping("/{modelId}")
    public Map<String, Object> create(@PathVariable long modelId,
            @RequestBody(required = false) Map<String, Object> data,
            HttpServletRequest request) {
        return withPreviewContext(request, () -> engine.create(modelId, data));
    }

    @PutMapping("/{modelId}/{id}")
    public void update(@PathVariable long modelId, @PathVariable long id,
            @RequestBody(required = false) Map<String, Object> data,
            HttpServletRequest request) {
        withPreviewContext(request, () -> {
            engine.update(modelId, id, data);
            return null;
        });
    }

    @DeleteMapping("/{modelId}/{id}")
    public void delete(@PathVariable long modelId, @PathVariable long id,
            HttpServletRequest request) {
        withPreviewContext(request, () -> {
            engine.delete(modelId, id);
            return null;
        });
    }

    // ---------- A.1 批量 upsert ----------

    @PostMapping("/{modelId}/batch")
    public Map<String, Object> batch(@PathVariable long modelId,
            @RequestBody Map<String, Object> body,
            HttpServletRequest request) {
        return withPreviewContext(request, () -> {
            if (body == null) {
                throw new BizException("VALIDATION_FAILED", "批量请求体缺失");
            }
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> rows = (List<Map<String, Object>>) body.get("rows");
            String keyField = (String) body.get("keyField");
            if (keyField == null || keyField.isBlank()) {
                throw new BizException("VALIDATION_FAILED", "keyField 必填（批量冲突键）");
            }
            return engine.batchUpsert(modelId, rows, keyField);
        });
    }

    // ---------- A.3 唯一性校验 ----------

    @PostMapping("/{modelId}/unique-check")
    public Map<String, Object> uniqueCheck(@PathVariable long modelId,
            @RequestBody Map<String, Object> body,
            HttpServletRequest request) {
        return withPreviewContext(request, () -> {
            String fieldKey = (String) body.get("field");
            Object value = body.get("value");
            Long excludeId = body.get("excludeId") instanceof Number n ? n.longValue() : null;
            return engine.uniqueCheck(modelId, fieldKey, value, excludeId);
        });
    }

    // ---------- A.4 聚合 ----------

    @PostMapping("/{modelId}/aggregate")
    public Map<String, Object> aggregate(@PathVariable long modelId,
            @RequestBody Map<String, Object> body,
            HttpServletRequest request) {
        return withPreviewContext(request, () -> {
            AggRequest agg = AggregateBuilder.parseRequest(modelId, body);
            return engine.aggregate(agg);
        });
    }

    // ---------- 字段元数据（运行时装载面） ----------

    /**
     * 可见字段元数据（2026-10-30 补齐：前端宿主 GET /api/models/{id}/fields 端点不存在——
     * 运行时表单装载链第一步即断）。权限口径与数据面同源：字段级权限过滤后的可见 ACTIVE 集
     * （03BE §3.4 授权集语义——不可见字段不出现在表单元数据中，防推断）。
     */
    @GetMapping("/{modelId}/fields")
    public Map<String, Object> fields(@PathVariable long modelId, HttpServletRequest request) {
        return withPreviewContext(request, () -> engine.visibleFieldViews(modelId));
    }

    // ---------- 内部 ----------

    private static QueryRequest toQueryRequest(long modelId, Map<String, Object> body) {
        if (body == null) {
            return new QueryRequest(modelId, null, null, 1, 20, null, 0, false);
        }
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> sorts = (List<Map<String, Object>>) body.get("sorts");
        @SuppressWarnings("unchecked")
        List<String> fields = (List<String>) body.get("fields");
        return new QueryRequest(modelId,
                (Map<String, Object>) body.get("filter"),
                sorts,
                body.get("page") instanceof Number n ? n.intValue() : 1,
                body.get("size") instanceof Number n2 ? n2.intValue() : 20,
                fields,
                body.get("relationDepth") instanceof Number n3 ? n3.intValue() : 0,
                Boolean.TRUE.equals(body.get("includeDeletedFields")));
    }

    /** 预览上下文绑定模板（04BE §A.7）：属性 → ThreadLocal → finally 清理。 */
    private static <T> T withPreviewContext(HttpServletRequest request, java.util.function.Supplier<T> body) {
        Boolean preview = (Boolean) request.getAttribute("auth.preview");
        boolean isPreview = Boolean.TRUE.equals(preview);
        Object pageId = request.getAttribute("auth.previewPageId");
        Object allowWrite = request.getAttribute("auth.previewAllowRealWrite");
        Object appId = request.getAttribute("auth.previewAppId");
        try {
            PreviewContext.bind(isPreview,
                    appId instanceof Number n ? n.longValue() : null,
                    pageId instanceof Number n2 ? n2.longValue() : null,
                    allowWrite instanceof Boolean b ? b : null);
            return body.get();
        } finally {
            PreviewContext.clear();
        }
    }
}
