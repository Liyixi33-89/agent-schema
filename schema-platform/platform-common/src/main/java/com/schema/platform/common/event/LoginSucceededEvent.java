package com.schema.platform.common.event;

/**
 * 登录成功事件（09BE §4 seat.active 服务端终审口径扩展）：
 * 登录成功即活跃触发——由 AuthService 登录成功路径在事务内发布，
 * metering 模块监听落 usage_event（metric=seat.active, source=SERVER）。
 * 发布方零依赖 metering（Spring 事件解耦，bootstrap 组合根背书）。
 */
public record LoginSucceededEvent(long tenantId, long userId) {
}