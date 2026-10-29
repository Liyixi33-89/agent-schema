package com.schema.platform.common.web;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 业务错误（10BE §A.2）：{code:'BIZ_XXX', message, traceId, details?}；
 * HTTP 状态由接口层错误处理器按 code 映射。
 */
public class BizException extends RuntimeException {

    private final String code;
    private final Map<String, Object> details;

    public BizException(String code, String message) {
        this(code, message, null);
    }

    public BizException(String code, String message, Map<String, Object> details) {
        super(message);
        this.code = code;
        this.details = details != null ? details : Map.of();
    }

    public String code() {
        return code;
    }

    public Map<String, Object> details() {
        return details;
    }

    public Map<String, Object> body(String traceId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", code);
        body.put("message", getMessage());
        body.put("traceId", traceId);
        if (!details.isEmpty()) {
            body.put("details", details);
        }
        return body;
    }

    // 01BE §A.5 本域错误码工厂
    public static BizException versionConflict(int serverVersion) {
        return new BizException("MODEL_VERSION_CONFLICT", "Schema 版本冲突，请刷新后重试",
                Map.of("serverVersion", serverVersion));
    }

    public static BizException confirmTokenInvalid(String reason) {
        return new BizException("CONFIRM_TOKEN_INVALID", "确认令牌无效: " + reason);
    }

    public static BizException fieldKeyImmutable() {
        return new BizException("FIELD_KEY_IMMUTABLE", "字段标识与类型创建后不可修改");
    }

    public static BizException circularDependency(java.util.List<String> cycle) {
        return new BizException("CIRCULAR_DEPENDENCY", "计算字段依赖成环: " + String.join(" -> ", cycle));
    }

    public static BizException notFound(String what) {
        return new BizException("MODEL_NOT_FOUND", what + " 不存在");
    }
}
