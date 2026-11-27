package com.schema.bootstrap;

import com.schema.flow.application.FlowNotifyPort;
import com.schema.notification.application.NotificationService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.List;
import java.util.Map;

/**
 * 流程通知适配器装配（spec 021 T7 的跨模块桥接）。
 *
 * ## 为什么桥接放在 bootstrap
 * flow-module 的 pom 只有 platform-common（零业务模块耦合，与 05BE 分期声明一致）。
 * 若要它直接调 NotificationService，就得加 notification-module 依赖，
 * 而 notification-module 又依赖 iam-module —— 会给流程核心引入不必要的耦合面。
 *
 * 组合根 bootstrap 同时依赖两边，在这里做「端口 → 适配器」的焊接，
 * 与既有 {@link BuildGateConfig}（build 域的 DesignCapabilityGate）同一手法。
 *
 * ## 通知失败的处理立场
 * 适配器内部**吞掉通知异常**（记 ERROR）。理由：
 * 审批/发起的业务结果比「通知是否送达」重要——通知模块故障不应回滚流程。
 * 通知模块自身的 SUPERSEDED/SUPPRESSED 状态留痕保证可审计（12BE §5）。
 * 同时 FlowInstanceService 外层还有 safeNotify 二次兜底，双保险。
 */
@Configuration
public class FlowNotifyConfig {

    private static final Logger log = LoggerFactory.getLogger(FlowNotifyConfig.class);

    @Bean
    public FlowNotifyPort flowNotifyAdapter(NotificationService notifications) {
        return new NotificationServiceFlowNotifyAdapter(notifications);
    }

    /** 端口实现：转调 notification-module。 */
    static final class NotificationServiceFlowNotifyAdapter implements FlowNotifyPort {

        /** 站内信业务大类；与 NotifyPolicy.BIZ_TYPES 内的 FLOW_TODO / FLOW_DONE 对应 */
        private static final String BIZ_TODO = "FLOW_TODO";
        private static final String BIZ_DONE = "FLOW_DONE";

        private final NotificationService notifications;

        NotificationServiceFlowNotifyAdapter(NotificationService notifications) {
            this.notifications = notifications;
        }

        @Override
        public void todo(String instanceId, List<Long> assigneeIds, Map<String, Object> vars) {
            if (assigneeIds == null || assigneeIds.isEmpty()) {
                return;
            }
            long tenantId = tenantIdOf(vars);
            String bizRef = String.valueOf(vars.getOrDefault("bizRef", instanceId));
            for (Long assignee : assigneeIds) {
                if (assignee == null) {
                    continue;
                }
                try {
                    notifications.send(tenantId, BIZ_TODO, bizRef, assignee,
                            "FLOW_TODO_APPROVE", vars, jumpUrl(instanceId));
                } catch (RuntimeException e) {
                    log.error("[FLOW_NOTIFY_FAILED] todo instance={} assignee={}: {}",
                            instanceId, assignee, e.toString());
                }
            }
        }

        @Override
        public void finished(String instanceId, long initiatorId, boolean approved,
                String comment, Map<String, Object> vars) {
            long tenantId = tenantIdOf(vars);
            String bizRef = String.valueOf(vars.getOrDefault("bizRef", instanceId));
            String templateKey = approved ? "FLOW_DONE_APPROVED" : "FLOW_DONE_REJECTED";
            try {
                notifications.send(tenantId, BIZ_DONE, bizRef, initiatorId,
                        templateKey, vars, jumpUrl(instanceId));
            } catch (RuntimeException e) {
                log.error("[FLOW_NOTIFY_FAILED] finished instance={} initiator={}: {}",
                        instanceId, initiatorId, e.toString());
            }
        }

        /**
         * 站内信跳转：前端审批中心实例详情。
         *
         * 2026-11-27 评审修复：原链接 `/runtime/flow-instances/{id}` 对应的路由
         * 从未实现（runtime 是 hash 路由，且审批中心在 `#/approval/{id}`）。
         * 通知点进去会 404 或落回首页——等于失效。
         *
         * 路由定义见 `apps/runtime/src/app/route.ts`：
         * `#/approval` 列表，`#/approval/{instanceId}` 直接开详情。
         */
        private static String jumpUrl(String instanceId) {
            return "/runtime/#/approval/" + instanceId;
        }

        /**
         * 租户 id 从流程变量取（start 时写入的 modelId/recordId 同批），
         * 缺失则退回 TenantContext —— 两者都拿不到时用 1（单租户部署兜底，
         * 与 FlowIT 的测试租户口径一致）。
         */
        private static long tenantIdOf(Map<String, Object> vars) {
            Object v = vars == null ? null : vars.get("tenantId");
            if (v instanceof Number n) {
                return n.longValue();
            }
            var ctx = com.schema.platform.common.tenant.TenantContext.get();
            return ctx == null ? 1L : ctx.tenantId();
        }
    }
}