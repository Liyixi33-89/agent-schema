package com.schema.flow;

import com.schema.flow.application.FlowDeploymentGateway;
import com.schema.flow.domain.FlowErrors;
import com.schema.platform.common.web.BizException;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 引擎关闭态的行为契约（spec 021 §8 授权第 3 条「生产/验收不自动建 ACT_* 表」）。
 *
 * 验证两件事：
 * 1. 容器里恰好一个 FlowDeploymentGateway，且是 Noop（无 Flowable）
 * 2. 该网关 isAvailable=false 且 deploy 明确失败——不产生「已发布但未部署」的假状态
 */
@SpringBootTest(classes = com.schema.bootstrap.SchemaApplication.class,
        properties = {
                "spring.datasource.url=jdbc:postgresql://127.0.0.1:1/none",
                "spring.flyway.enabled=false",
                "flowable.process.enabled=false",
        })
class FlowDeploymentGatewayDisabledTest {

    @Autowired
    private ApplicationContext ctx;

    @Autowired
    private FlowDeploymentGateway gateway;

    @Test
    void exactlyOneGatewayAndItIsNoop() {
        String[] beans = ctx.getBeanNamesForType(FlowDeploymentGateway.class);
        assertEquals(1, beans.length, "容器里必须恰好一个部署网关（真实与 Noop 互斥）");
        assertTrue(gateway.getClass().getSimpleName().contains("Noop"),
                "引擎关闭时应装配 NoopFlowDeploymentGateway，实际: " + gateway.getClass().getName());
        assertFalse(gateway.isAvailable(), "无引擎环境 isAvailable 必须为 false");
    }

    @Test
    void deployFailsLoudlyWhenEngineDisabled() {
        BizException e = assertThrows(BizException.class,
                () -> gateway.deploy("leave", "leave.bpmn20.xml", "<definitions/>"));
        assertEquals(FlowErrors.FLOW_DEF_NOT_PUBLISHED, e.code(),
                "必须明确失败，不能静默成功（否则发布后发起实例才暴露）");
    }
}