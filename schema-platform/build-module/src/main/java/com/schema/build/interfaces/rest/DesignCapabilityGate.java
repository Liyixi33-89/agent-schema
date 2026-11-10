package com.schema.build.interfaces.rest;

/**
 * 设计能力闸（与 metadata 域 DesignGate 同构）：build 模块不直查权限表，
 * 实现由组合根装配（bootstrap 委托 IAM AppRoleService）。
 */
public interface DesignCapabilityGate {

    void requireDesignCapability(long appId);
}
