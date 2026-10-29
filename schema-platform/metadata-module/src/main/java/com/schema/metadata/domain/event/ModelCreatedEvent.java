package com.schema.metadata.domain.event;

/**
 * 模型创建事件（01BE→02BE 联动）：建模时自动建物理表（02BE §2.1）。
 * metadata 不反向依赖 data-module——经 Spring 事件解耦，bootstrap 组合根背书。
 */
public record ModelCreatedEvent(long tenantId, long modelId, String modelKey) {
}
