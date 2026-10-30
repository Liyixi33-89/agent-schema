package com.schema.metering.interfaces.rest;

import com.schema.metering.application.MeteringEventService;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 计量接口（09BE §A.1-A.2）：事件上报（202 受理）+ 用量查询。
 */
@RestController
@RequestMapping("/api/metering")
public class MeteringController {

    private final MeteringEventService service;

    public MeteringController(MeteringEventService service) {
        this.service = service;
    }

    /** 批量上报：202 异步语义（直接入库受理）；合规违规整批 422 {invalidIndices[]}。 */
    @PostMapping("/events")
    public ResponseEntity<Object> ingest(@RequestBody Map<String, Object> body) {
        TenantInfo t = tenant();
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> events = (List<Map<String, Object>>) body.get("events");
        List<Integer> invalid = service.ingest(t.tenantId(), t.operatorId(), events);
        if (invalid != null) {
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("invalidIndices", invalid);
            throw new BizException("EVENT_PAYLOAD_INVALID", "事件合规校验失败（整批拒绝）", err);
        }
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(Map.of("accepted", true));
    }

    /** 用量序列（09BE §A.2）。 */
    @GetMapping("/usage")
    public Map<String, Object> usage(@RequestParam String metric,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to) {
        return service.usage(tenant().tenantId(), metric, from, to);
    }

    /** 租户用量卡片（09BE §A.2 summary：双席位口径并排）。 */
    @GetMapping("/usage/summary")
    public Map<String, Object> summary() {
        return service.summary(tenant().tenantId(), LocalDate.now());
    }

    private static TenantInfo tenant() {
        TenantInfo t = TenantContext.get();
        if (t == null) {
            throw BizException.unauthorized("租户上下文缺失");
        }
        return t;
    }
}
