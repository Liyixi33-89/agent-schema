package com.schema.bootstrap;

import com.schema.iam.application.AppRoleService;
import com.schema.metadata.interfaces.rest.DesignGate;
import com.schema.platform.common.tenant.TenantContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 设计能力闸装配（M12）：/api/models 全链的授权闸——建模 = developer/app_admin/org:manage。
 * 实现委托 IAM（逐请求实时判定）；装配放 bootstrap（组合根——模块间桥接不进业务模块）。
 */
@Configuration
public class DesignGateConfig {

    @Bean
    public DesignGate designGate(AppRoleService appRoles) {
        return appId -> appRoles.requireDesignCapability(
                TenantContext.get().tenantId(), appId, TenantContext.get().operatorId());
    }
}
