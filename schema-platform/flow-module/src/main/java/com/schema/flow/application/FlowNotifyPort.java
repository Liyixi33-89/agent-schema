package com.schema.flow.application;

import java.util.Map;

/**
 * 流程通知端口（spec 021 T7）。
 *
 * ## 为什么是端口而不是直接依赖 notification-module
 * 与 {@link FlowExecutionEngine} 同理（DIP）：flow-module 只声明「我需要发通知」，
 * 具体通道由组合根（bootstrap）装配。好处：
 * - flow-module 保持零业务模块依赖（pom 只有 platform-common）
 * - 「引擎未启用 / 通知未接线」时可用 NOOP 优雅降级，不让流程卡死
 * - 测试可注入记录型桩，断言「发了什么」而不用起整个通知模块
 *
 * ## 与 {@link com.schema.notification.application.NotificationService} 的关系
 * 实现类在 bootstrap（{@code FlowNotifyAdapter}），转调 NotificationService.send()。
 * 通知失败**不得回滚流程事务**——业务闭环优先于通知送达（见实现类注释）。
 */
public interface FlowNotifyPort {

    /**
     * 有新的待办产生（approval 节点完成派单后）。
     *
     * @param instanceId 流程实例
     * @param assigneeIds 审批人（可能多人）
     * @param vars 模板变量：flowName / bizRef / instanceId
     */
    void todo(String instanceId, java.util.List<Long> assigneeIds, Map<String, Object> vars);

    /**
     * 流程办结（approve 或 reject 后实例进入 FINISHED）。
     *
     * @param approved true → FLOW_DONE_APPROVED；false → FLOW_DONE_REJECTED
     * @param initiatorId 发起人（结果通知的接收者）
     */
    void finished(String instanceId, long initiatorId, boolean approved,
                  String comment, Map<String, Object> vars);
}