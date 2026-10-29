package com.schema.metadata.interfaces.rest;

import com.schema.metadata.application.MetadataCommandService;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 内部接口（01BE §A.4，服务间调用不经网关）：
 * /internal/references —— page-service 保存页面时的字段引用登记（M4.3 消费方）。
 */
@RestController
@RequestMapping("/internal")
public class InternalController {

    private final MetadataCommandService service;

    public InternalController(MetadataCommandService service) {
        this.service = service;
    }

    @PostMapping("/references")
    public Map<String, Object> register(@RequestBody Map<String, Object> body) {
        long modelId = Long.parseLong(String.valueOf(body.get("modelId")));
        String fieldKey = String.valueOf(body.get("fieldKey"));
        String refType = String.valueOf(body.get("refType"));
        long refId = Long.parseLong(String.valueOf(body.get("refId")));
        service.registerReference(modelId, fieldKey, refType, refId);
        return Map.of();
    }
}
