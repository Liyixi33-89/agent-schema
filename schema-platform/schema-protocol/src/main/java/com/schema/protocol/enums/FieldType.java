package com.schema.protocol.enums;

/**
 * 字段类型枚举（M1.4 后端协议镜像）——与前端 schema-protocol FIELD_TYPES 常量一一对应。
 * 唯一真源：前端 contract/export/enums.json（脚本生成），CI 做双端 diff（M1.5）。
 * 12 种；textarea/datetime 为控件配置项不进枚举（评审稿 §7 #9 定版）。
 */
public enum FieldType {
    TEXT("text"),
    NUMBER("number"),
    DATE("date"),
    ENUM("enum"),
    BOOLEAN("boolean"),
    FILE("file"),
    RICHTEXT("richtext"),
    RELATION("relation"),
    GEO("geo"),
    USER("user"),
    DEPT("dept"),
    COMPUTED("computed");

    private final String code;

    FieldType(String code) {
        this.code = code;
    }

    public String code() {
        return code;
    }
}
