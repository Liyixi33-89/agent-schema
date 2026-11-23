package com.schema.flow.interfaces.rest;

import com.schema.flow.application.FlowDefinitionService;
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
 * 流程定义接口（spec 021 §3.1 / 05BE §A.1 子集）。
 * 接口层只做协议转换与租户上下文装配（四层职责铁律）。
 */
@RestController
@RequestMapping("/api/flows")
public class FlowDefinitionController {

    private final FlowDefinitionService service;

    public FlowDefinitionController(FlowDefinitionService service) {
        this.service = service;
    }

    @GetMapping
    public Map<String, Object> list(@RequestParam long appId) {
        return service.list(appId);
    }

    @PostMapping
    public Map<String, Object> create(@RequestBody Map<String, Object> body) {
        return service.create(longOf(body.get("appId")), str(body.get("name")), body.get("flowSchema"));
    }

    @PutMapping("/{id}/draft")
    public Map<String, Object> saveDraft(@PathVariable long id, @RequestBody Map<String, Object> body) {
        return service.saveDraft(id, body.get("flowSchema"), intOrNull(body.get("baseVersion")));
    }

    @PostMapping("/{id}/publish")
    public Map<String, Object> publish(@PathVariable long id) {
        return service.publish(id);
    }

    @GetMapping("/{id}")
    public Map<String, Object> detail(@PathVariable long id) {
        return service.detail(id);
    }

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }

    private static long longOf(Object o) {
        if (o instanceof Number n) {
            return n.longValue();
        }
        return Long.parseLong(String.valueOf(o));
    }

    private static Integer intOrNull(Object o) {
        if (o instanceof Number n) {
            return n.intValue();
        }
        return o == null ? null : Integer.parseInt(String.valueOf(o));
    }
}