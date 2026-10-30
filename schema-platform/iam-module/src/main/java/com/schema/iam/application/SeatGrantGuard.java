package com.schema.iam.application;

import java.util.List;

/**
 * 授权席位护栏 SPI（13BE §7 授权并发控制）：
 * iam-module 定义接口、metering-module 提供实现（LicensedSeatCalculator）——
 * 保持模块单向依赖（metering → iam），授权挂点经 ObjectProvider 可选装配。
 */
public interface SeatGrantGuard {

    /**
     * 新增设计能力角色触限判定：超限抛 SEAT_LIMIT_EXCEEDED（403）。
     *
     * @param tenantId              租户
     * @param userIdsGrantedDesign  本次被授予设计能力角色的用户集合
     */
    void assertGrantAllowed(long tenantId, List<Long> userIdsGrantedDesign);
}
