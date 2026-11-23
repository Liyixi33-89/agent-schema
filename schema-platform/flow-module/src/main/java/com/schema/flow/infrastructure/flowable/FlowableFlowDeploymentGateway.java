package com.schema.flow.infrastructure.flowable;

import com.schema.flow.application.FlowDeploymentGateway;
import com.schema.platform.common.web.BizException;
import com.schema.flow.domain.FlowErrors;
import org.flowable.engine.RepositoryService;
import org.flowable.engine.repository.Deployment;

import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * 真实 Flowable 部署。
 *
 * ⚠️ 本类**不加** @Component/@ConditionalOnBean——由 {@link FlowDeploymentConfig}
 * 按 RepositoryService 是否存在决定是否构造（组件扫描的条件评估顺序不可靠，
 * 实测会两个网关都不装配）。
 */
public class FlowableFlowDeploymentGateway implements FlowDeploymentGateway {

    private final RepositoryService repositoryService;

    public FlowableFlowDeploymentGateway(RepositoryService repositoryService) {
        this.repositoryService = repositoryService;
    }

    @Override
    public boolean isAvailable() {
        return true;
    }

    @Override
    public String deploy(String processKey, String resourceName, String bpmnXml) {
        try {
            Deployment deployment = repositoryService.createDeployment()
                    .name(processKey)
                    .addString(resourceName, bpmnXml)
                    .deploy();
            return deployment.getId();
        } catch (RuntimeException e) {
            // BPMN 非法/引擎拒绝 → 统一转本域错误（不把 Flowable 异常类型泄漏到接口层）
            throw new BizException(FlowErrors.SCHEMA_INVALID,
                    "BPMN 部署失败: " + e.getMessage(),
                    Map.of("processKey", processKey));
        }
    }

    /** 供测试断言 XML 内容（部署后可按 deployment 反查资源）。 */
    public String readResource(String deploymentId) {
        try (var in = repositoryService.getResourceAsStream(deploymentId,
                repositoryService.getDeploymentResourceNames(deploymentId).get(0))) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new IllegalStateException("读取部署资源失败: " + deploymentId, e);
        }
    }
}