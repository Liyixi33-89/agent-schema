package com.schema.flow.interfaces.rest;

import com.schema.flow.domain.FlowErrors;
import com.schema.platform.common.web.BizException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.Map;
import java.util.UUID;

/**
 * 流程域统一错误体（spec 021 §3.6 错误码 → HTTP 映射）。
 */
@RestControllerAdvice(basePackages = "com.schema.flow")
public class FlowExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(FlowExceptionHandler.class);

    @ExceptionHandler(BizException.class)
    public ResponseEntity<Map<String, Object>> biz(BizException e) {
        String traceId = UUID.randomUUID().toString();
        HttpStatus status = switch (e.code()) {
            case FlowErrors.NODE_TYPE_NOT_SUPPORTED,
                 FlowErrors.COMMENT_REQUIRED,
                 FlowErrors.SCHEMA_INVALID -> HttpStatus.UNPROCESSABLE_ENTITY;
            case FlowErrors.INSTANCE_ALREADY_RUNNING,
                 FlowErrors.TASK_ALREADY_COMPLETED,
                 FlowErrors.FLOW_DEF_NOT_PUBLISHED,
                 FlowErrors.VERSION_CONFLICT -> HttpStatus.CONFLICT;
            case FlowErrors.TASK_NOT_ASSIGNED -> HttpStatus.FORBIDDEN;
            case FlowErrors.FLOW_DEF_NOT_FOUND,
                 FlowErrors.INSTANCE_NOT_FOUND,
                 FlowErrors.TASK_NOT_FOUND -> HttpStatus.NOT_FOUND;
            case FlowErrors.NOT_IMPLEMENTED -> HttpStatus.NOT_IMPLEMENTED;
            default -> HttpStatus.BAD_REQUEST;
        };
        log.warn("flow error {} : {}", e.code(), e.getMessage());
        return ResponseEntity.status(status).body(e.body(traceId));
    }
}