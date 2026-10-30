package com.schema.data.application;

import com.schema.data.infrastructure.outbox.OutboxRelay;
import com.schema.metadata.domain.event.ModelCreatedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * 模型创建 → 物理表自动创建（02BE §2.1「建模时自动创建」）。
 *
 * 双链路（2026-10-30 收口）：
 * 1. 同步链：@EventListener 同事务直连建表（建表失败连带建模失败——强一致主路径）；
 * 2. Outbox 链：同事务登记 outbox_event（ddl.table.ensure），进程重启/同步链失败后
 *    由 OutboxRelay 补偿建表（ensureTable 幂等——至少一次投递语义安全）。
 */
@Component
public class ModelCreatedListener {

    private final DynamicQueryEngine engine;
    private final OutboxRelay outbox;

    public ModelCreatedListener(DynamicQueryEngine engine, OutboxRelay outbox) {
        this.engine = engine;
        this.outbox = outbox;
    }

    @EventListener
    public void on(ModelCreatedEvent event) {
        // 同步主路径：建表失败建模失败（事务一致）
        engine.ensurePhysicalTable(event.tenantId(), event.modelId());
        // Outbox 补偿登记：重启后或同步链路遗漏时由中继幂等补建（租户随事件传递——多租户归属正确）
        outbox.enqueue(event.tenantId(), "ddl.table.ensure",
                "{\"tenantId\":" + event.tenantId() + ",\"modelId\":" + event.modelId() + "}");
    }
}
