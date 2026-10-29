package com.schema.metadata.domain.model;

/**
 * 确认模式（01BE §4.3 删除确认协议三档）：
 * INFO（低风险一键确认）/ CHECKBOX（中风险勾选）/ TYPE_MODEL_NAME（高风险回传模型名原文）。
 */
public enum ConfirmMode {
    INFO("INFO"),
    CHECKBOX("CHECKBOX"),
    TYPE_MODEL_NAME("TYPE_MODEL_NAME");

    private final String code;

    ConfirmMode(String code) {
        this.code = code;
    }

    public String code() {
        return code;
    }

    public static ConfirmMode of(String code) {
        for (ConfirmMode m : values()) {
            if (m.code.equals(code)) {
                return m;
            }
        }
        throw new IllegalArgumentException("非法 confirmMode: " + code);
    }
}
