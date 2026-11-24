package com.schema.flow.infrastructure.flowable;

import com.schema.flow.application.FlowDeploymentGateway;
import com.schema.flow.domain.FlowErrors;
import com.schema.platform.common.web.BizException;

import java.util.Map;

/**
 * 无引擎环境的部署网关（生产/验收库默认态）。
 *
 * ⚠️ 本类**不加** @Component——由 {@link FlowDeploymentConfig} 在
 * RepositoryService 缺失时构造（装配互斥在配置类里保证，见该类注释）。
 *
 * deploy() 直接失败而非静默成功——「发布了但没有 deployment」
 * 会在发起实例时才暴露，属最难排查的假状态，必须在此处挡住。
 */
public class NoopFlowDeploymentGateway implements FlowDeploymentGateway {

    @Override
    public boolean isAvailable() {
        return false;
    }

    @Override
    public String deploy(String processKey, String resourceName, String bpmnXml) {
        throw new BizException(FlowErrors.FLOW_DEF_NOT_PUBLISHED,
                "流程引擎未启用（flowable.process.enabled=false），无法部署流程",
                Map.of("hint", "需在具备 ACT_* 表的环境显式开启 FLOWABLE_ENABLED=true"));
    }
}