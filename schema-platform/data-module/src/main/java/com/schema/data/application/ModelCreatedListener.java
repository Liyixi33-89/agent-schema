package com.schema.data.application;

import com.schema.metadata.domain.event.ModelCreatedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * 模型创建 → 物理表自动创建监听器（02BE §2.1「建模时自动创建」）。
 * 与建模同事务（@EventListener 默认同步参与发布者事务——建表失败连带建模失败，保证一致）。
 */
@Component
public class ModelCreatedListener {

    private final DynamicQueryEngine engine;

    public ModelCreatedListener(DynamicQueryEngine engine) {
        this.engine = engine;
    }

    @EventListener
    public void on(ModelCreatedEvent event) {
        engine.ensurePhysicalTable(event.tenantId(), event.modelId());
    }
}
