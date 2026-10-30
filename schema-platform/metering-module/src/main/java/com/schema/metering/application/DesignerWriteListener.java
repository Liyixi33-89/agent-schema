package com.schema.metering.application;

import com.schema.platform.common.event.DesignerWriteEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * seat.active 服务端终审监听（09BE §4）：
 * 设计器写操作事件 → usage_event(metric=seat.active, source=SERVER)。
 * 服务端为准：同一用户前端漏斗事件与本事件并存时只信本源（聚合口径已过滤 source）。
 */
@Component
public class DesignerWriteListener {

    private final MeteringEventService service;

    public DesignerWriteListener(MeteringEventService service) {
        this.service = service;
    }

    @EventListener
    public void on(DesignerWriteEvent event) {
        service.recordServer(event.tenantId(), event.operatorId(), "seat.active", 1L, null,
                "{\"surface\":\"" + event.surface() + "\",\"action\":\"" + event.action() + "\"}");
    }
}
