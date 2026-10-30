package com.schema.platform.common.event;

/**
 * 设计器写操作事件（09BE §4 seat.active 服务端终审口径）：
 * 计费口径一律服务端埋点——本事件由保存/发布/脚本保存钩子在事务内发布，
 * metering 模块监听落 usage_event（metric=seat.active, source=SERVER）。
 * 发布方零依赖 metering（Spring 事件解耦，bootstrap 组合根背书）。
 */
public record DesignerWriteEvent(long tenantId, long operatorId, String surface, String action) {
}
