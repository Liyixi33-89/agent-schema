package com.schema.bootstrap;

import com.schema.build.interfaces.rest.DesignCapabilityGate;
import com.schema.iam.application.AppRoleService;
import com.schema.platform.common.tenant.TenantContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * build 域设计能力闸装配（M14）：脚本编译 = 应用设计能力——developer/app_admin/org:manage。
 * 与 metadata 域 DesignGate 同构：实现委托 IAM，装配放组合根（模块间桥接不进业务模块）。
 */
@Configuration
public class BuildGateConfig {

    @Bean
    public DesignCapabilityGate buildDesignGate(AppRoleService appRoles) {
        return appId -> appRoles.requireDesignCapability(
                TenantContext.get().tenantId(), appId, TenantContext.get().operatorId());
    }
}
