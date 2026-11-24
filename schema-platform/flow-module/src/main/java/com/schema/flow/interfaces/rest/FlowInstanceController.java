package com.schema.flow.interfaces.rest;

import com.schema.flow.application.FlowInstanceService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 实例与任务接口（spec 021 §3.3-3.5）。
 */
@RestController
@RequestMapping("/api")
public class FlowInstanceController {

    private final FlowInstanceService service;

    public FlowInstanceController(FlowInstanceService service) {
        this.service = service;
    }

    /** 发起：POST /api/records/{modelId}/{recordId}/flow/start?flowDefId= */
    @PostMapping("/records/{modelId}/{recordId}/flow/start")
    public Map<String, Object> start(@PathVariable long modelId, @PathVariable long recordId,
            @RequestBody Map<String, Object> body) {
        return service.start(modelId, recordId, longOf(body.get("flowDefId")));
    }

    /** 待办：GET /api/my/tasks */
    @GetMapping("/my/tasks")
    public Map<String, Object> myTasks() {
        return service.myTasks();
    }

    /** 办理：POST /api/tasks/{taskId}/complete */
    @PostMapping("/tasks/{taskId}/complete")
    public Map<String, Object> complete(@PathVariable String taskId,
            @RequestBody Map<String, Object> body) {
        // approved 缺省为 true（前端「同意」按钮不传该字段是常见写法）
        boolean approved = body.get("approved") == null
                || Boolean.parseBoolean(String.valueOf(body.get("approved")));
        String comment = body.get("comment") == null ? null : String.valueOf(body.get("comment"));
        return service.complete(taskId, approved, comment);
    }

    /** 实例详情聚合：GET /api/flow-instances/{instanceId} */
    @GetMapping("/flow-instances/{instanceId}")
    public Map<String, Object> detail(@PathVariable String instanceId) {
        return service.detail(instanceId);
    }

    private static long longOf(Object o) {
        if (o instanceof Number n) {
            return n.longValue();
        }
        return Long.parseLong(String.valueOf(o));
    }
}