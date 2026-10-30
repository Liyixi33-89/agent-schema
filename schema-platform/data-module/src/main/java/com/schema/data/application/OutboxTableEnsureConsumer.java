package com.schema.data.application;

import com.schema.data.infrastructure.outbox.SpringEventBridge;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * Outbox 本地消费方：ddl.table.ensure 事件 → 幂等补建物理表（至少一次投递安全）。
 */
@Component
public class OutboxTableEnsureConsumer {

    private final DynamicQueryEngine engine;

    public OutboxTableEnsureConsumer(DynamicQueryEngine engine) {
        this.engine = engine;
    }

    @EventListener
    public void on(SpringEventBridge.OutboxDelivered event) {
        if (!"ddl.table.ensure".equals(event.topic())) {
            return;
        }
        Object modelId = event.payload().get("modelId");
        if (modelId instanceof Number n) {
            engine.ensurePhysicalTable(1L, n.longValue()); // 单租户 MVP：tenant 恒 1
        }
    }
}
