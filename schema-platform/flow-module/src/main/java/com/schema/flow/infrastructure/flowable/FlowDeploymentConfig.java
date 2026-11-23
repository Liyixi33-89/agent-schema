package com.schema.flow.infrastructure.flowable;

import com.schema.flow.application.FlowDeploymentGateway;
import org.flowable.engine.RepositoryService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 部署网关装配（互斥选择，保证容器里恰好一个）。
 *
 * ⚠️ 为什么不在实现类上直接打 {@code @ConditionalOnBean/@ConditionalOnMissingBean}：
 * 组件扫描阶段的条件评估顺序不可靠——实测 {@code @ConditionalOnMissingBean} 会在
 * 真实网关注册前评估，导致两个都不装配、FlowDefinitionService 注入失败。
 * 改在同一个 @Configuration 里按方法顺序声明，语义确定：
 * - 有 RepositoryService（Flowable 已启用）→ 真实网关
 * - 否则 → Noop 网关
 */
@Configuration
public class FlowDeploymentConfig {

    @Bean
    public FlowDeploymentGateway flowDeploymentGateway(
            org.springframework.beans.factory.ObjectProvider<RepositoryService> repositoryService) {
        RepositoryService rs = repositoryService.getIfAvailable();
        // 引擎关闭时 RepositoryService 不存在 → 返回 Noop（明确失败，不静默成功）
        return rs == null ? new NoopFlowDeploymentGateway() : new FlowableFlowDeploymentGateway(rs);
    }
}