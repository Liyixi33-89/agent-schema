package com.schema.protocol.enums;

/**
 * 过滤操作符白名单（M1.4 后端协议镜像）——与前端 FILTER_OPS 常量一一对应，11 个。
 * isnull 全小写统一拼写（评审稿 §7 #5 定版）；不在白名单 = 直接 400（02BE §3.2）。
 */
public enum FilterOp {
    EQ("eq"),
    NE("ne"),
    IN("in"),
    NIN("nin"),
    GT("gt"),
    GTE("gte"),
    LT("lt"),
    LTE("lte"),
    LIKE("like"),
    BETWEEN("between"),
    ISNULL("isnull");

    private final String code;

    FilterOp(String code) {
        this.code = code;
    }

    public String code() {
        return code;
    }
}
