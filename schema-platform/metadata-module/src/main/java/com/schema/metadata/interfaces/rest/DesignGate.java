package com.schema.metadata.interfaces.rest;

/**
 * 设计能力闸（M12）：/api/models 全链授权接口——建模 = developer/app_admin/org:manage。
 * 实现由组合根装配（bootstrap DesignGateConfig 委托 IAM）——metadata 模块不直查权限表。
 */
public interface DesignGate {
    void requireDesignCapability(long appId);
}
