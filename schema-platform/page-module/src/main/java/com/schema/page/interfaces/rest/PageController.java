package com.schema.page.interfaces.rest;

import com.schema.page.application.PageCommandService;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 页面 CRUD 与草稿（04BE §A.1）。
 * 接口层只做协议转换与租户上下文装配（四层职责铁律）；appId 由查询参数显式传递。
 */
@RestController
@RequestMapping("/api/pages")
public class PageController {

    private final PageCommandService service;

    public PageController(PageCommandService service) {
        this.service = service;
    }

    @GetMapping
    public Map<String, Object> list(@RequestParam long appId,
            @RequestParam(required = false) String keyword) {
        return service.listPages(appId, keyword);
    }

    @PostMapping
    public Map<String, Object> create(@RequestBody Map<String, Object> body) {
        return service.createPage(longVal(body.get("appId")), str(body.get("pageKey")),
                str(body.get("name")), str(body.get("type")), longOrNull(body.get("modelId")),
                str(body.get("path")));
    }

    @GetMapping("/{id}/draft")
    public Map<String, Object> draft(@PathVariable long id) {
        return service.getDraft(id);
    }

    @PutMapping("/{id}/draft")
    public Map<String, Object> saveDraft(@PathVariable long id, @RequestBody Map<String, Object> body) {
        @SuppressWarnings("unchecked")
        Map<String, Object> schema = body.get("schema") instanceof Map<?, ?> m
                ? (Map<String, Object>) m : null;
        return service.saveDraft(id, schema, intVal(body.get("baseDraftVersion")));
    }

    @DeleteMapping("/{id}")
    public Map<String, Object> delete(@PathVariable long id) {
        service.deletePage(id);
        return Map.of();
    }

    @PutMapping("/{id}/path")
    public Map<String, Object> updatePath(@PathVariable long id, @RequestBody Map<String, Object> body) {
        service.updatePath(id, str(body.get("path")), str(body.get("name")));
        return Map.of();
    }

    private static String str(Object v) {
        return v instanceof String s ? s : null;
    }

    private static long longVal(Object v) {
        if (v instanceof Number n) {
            return n.longValue();
        }
        if (v instanceof String s && !s.isBlank()) {
            return Long.parseLong(s);
        }
        throw new IllegalArgumentException("数值字段缺失或非法");
    }

    private static Long longOrNull(Object v) {
        return v instanceof Number n ? n.longValue() : (v instanceof String s && !s.isBlank()
                ? Long.parseLong(s) : null);
    }

    private static int intVal(Object v) {
        if (v instanceof Number n) {
            return n.intValue();
        }
        if (v instanceof String s) {
            return Integer.parseInt(s);
        }
        throw new IllegalArgumentException("数值字段缺失或非法");
    }
}
