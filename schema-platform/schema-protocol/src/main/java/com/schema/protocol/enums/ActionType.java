package com.schema.protocol.enums;

/**
 * 页面动作类型枚举（M1.4 后端协议镜像）——与前端 ACTION_TYPES 常量一一对应，6 个。
 */
public enum ActionType {
    SUBMIT("SUBMIT"),
    TRIGGER_FLOW("TRIGGER_FLOW"),
    CALL_API("CALL_API"),
    OPEN_PAGE("OPEN_PAGE"),
    DELETE("DELETE"),
    CUSTOM_SCRIPT("CUSTOM_SCRIPT");

    private final String code;

    ActionType(String code) {
        this.code = code;
    }

    public String code() {
        return code;
    }
}
