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
     * 调用时机：角色写入之前（后置校验读到已写入角色，净新增恒为 0 形同虚设）。
     *
     * @param tenantId              租户
     * @param userIdsGrantedDesign  本次将被授予设计能力角色的用户集合
     */
    void assertGrantAllowed(long tenantId, List<Long> userIdsGrantedDesign);

    /**
     * 成员授权变更即时快照重算（13BE §2.4：席位变更当天不等次日调度）。
     * 由实现方同步重算该租户当日 licensed_seats 快照。
     */
    default void onSeatChanged(long tenantId) {
        // 默认空实现——未接入计量模块时跳过（调度日结兜底）
    }
}
