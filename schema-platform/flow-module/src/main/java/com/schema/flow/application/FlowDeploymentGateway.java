package com.schema.flow.application;

/**
 * 流程部署网关（DIP：应用层依赖抽象，Flowable 只在实现层出现）。
 *
 * 存在的理由：生产/验收库默认不启用 Flowable（不建 ACT_* 表），
 * 但定义 CRUD 仍需可用。把「部署」收进接口后：
 * - 引擎关闭 → {@link NoopFlowDeploymentGateway}（isAvailable=false，publish 明确失败）
 * - 引擎开启 → {@link FlowableFlowDeploymentGateway}（真实 deployment）
 *
 * 这样 flow-module 的其余部分完全不 import Flowable，
 * 单测/无引擎环境下也不会因类缺失炸启动。
 */
public interface FlowDeploymentGateway {

    /** 当前环境是否具备真实部署能力。 */
    boolean isAvailable();

    /**
     * 部署 BPMN。
     *
     * @param processKey 流程定义 key（Flowable 侧 processDefinitionKey）
     * @param resourceName 资源名（含 .bpmn20.xml 后缀）
     * @param bpmnXml BPMN 2.0 XML 内容
     * @return Flowable deployment id
     */
    String deploy(String processKey, String resourceName, String bpmnXml);
}