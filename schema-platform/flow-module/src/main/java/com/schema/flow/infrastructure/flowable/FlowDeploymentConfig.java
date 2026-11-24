package com.schema.flow.infrastructure.flowable;

import com.schema.flow.application.FlowDeploymentGateway;
import com.schema.flow.application.FlowExecutionEngine;
import com.schema.flow.domain.ApproverResolver;
import org.flowable.engine.HistoryService;
import org.flowable.engine.RepositoryService;
import org.flowable.engine.RuntimeService;
import org.flowable.engine.TaskService;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * 流程引擎相关的互斥装配（容器里每组恰好一个实现）。
 *
 * ⚠️ 为什么不用 {@code @ConditionalOnBean/@ConditionalOnMissingBean} 直接标在实现类上：
 * 组件扫描阶段的条件评估顺序不可靠——实测 {@code @ConditionalOnMissingBean} 会在
 * 真实实现注册前评估，导致两个都不装配、Service 注入失败。
 * 改在同一个 @Configuration 里用 ObjectProvider 显式判断，语义确定。
 */
@Configuration
public class FlowDeploymentConfig {

    @Bean
    public FlowDeploymentGateway flowDeploymentGateway(ObjectProvider<RepositoryService> provider) {
        RepositoryService rs = provider.getIfAvailable();
        return rs == null ? new NoopFlowDeploymentGateway() : new FlowableFlowDeploymentGateway(rs);
    }

    @Bean
    public FlowExecutionEngine flowExecutionEngine(
            ObjectProvider<RuntimeService> runtime,
            ObjectProvider<TaskService> task,
            ObjectProvider<HistoryService> history) {
        RuntimeService rs = runtime.getIfAvailable();
        TaskService ts = task.getIfAvailable();
        HistoryService hs = history.getIfAvailable();
        if (rs == null || ts == null || hs == null) {
            return new NoopExecutionEngine();
        }
        return new FlowableExecutionEngine(rs, ts, hs);
    }

    /**
     * 机构数据端口：直接查 sys_user / sys_dept / sys_role。
     *
     * 为什么不经 iam-module：iam 的 IamRepository 没有「部门成员/角色成员」查询，
     * 且跨模块依赖会引入循环风险。这里用只读 SQL 实现 OrgQueryPort，
     * 语义窄（只读）且与 iam 的表结构解耦在 SQL 层。
     */
    @Bean
    public ApproverResolver.OrgQueryPort flowOrgQueryPort(JdbcTemplate jdbc) {
        return new JdbcOrgQueryPort(jdbc);
    }
}