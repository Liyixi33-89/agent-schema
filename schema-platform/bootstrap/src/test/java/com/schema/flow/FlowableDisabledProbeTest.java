package com.schema.flow;

import org.flowable.engine.ProcessEngine;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 探针：验证 flowable.process.enabled=false 时 ProcessEngine 不会被装配。
 * 目的——确认可以安全地把 Flowable 关掉（生产/验收库不自动建 ACT_* 表），
 * 只在需要执行流程的环境（IT 库）显式开启。
 */
@SpringBootTest(classes = com.schema.bootstrap.SchemaApplication.class,
        properties = {
                "spring.datasource.url=jdbc:postgresql://127.0.0.1:1/none",
                "spring.flyway.enabled=false",
                "flowable.process.enabled=false",
                "flowable.idm.enabled=false",
                "flowable.dmn.enabled=false",
                "flowable.cmmn.enabled=false",
                "flowable.eventregistry.enabled=false",
                "flowable.app.enabled=false",
                "flowable.rest-api.enabled=false",
                "flowable.actuator.enabled=false",
        })
class FlowableDisabledProbeTest {

    @Autowired
    private ApplicationContext ctx;

    @Test
    void processEngineAbsentWhenDisabled() {
        String[] beans = ctx.getBeanNamesForType(ProcessEngine.class);
        assertTrue(beans.length == 0, "flowable.process.enabled=false 时不应装配 ProcessEngine");
        assertFalse(ctx.containsBean("processEngine"), "processEngine bean 不应存在");
        System.out.println("[PROBE] ProcessEngine beans = " + beans.length);
    }
}