package com.schema.build.interfaces.rest;

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
 * build 域统一错误体（04BE §A.6）。
 * SECURITY_BLOCKED → 422；BUILD_QUOTA_EXCEEDED → 429；编译失败 → 422（错误详情返回设计器展示）。
 */
@RestControllerAdvice(basePackages = "com.schema.build")
public class BuildExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(BuildExceptionHandler.class);

    @ExceptionHandler(BizException.class)
    public ResponseEntity<Map<String, Object>> biz(BizException e) {
        String traceId = UUID.randomUUID().toString();
        HttpStatus status = switch (e.code()) {
            case "SECURITY_BLOCKED", "COMPILE_FAILED" -> HttpStatus.UNPROCESSABLE_ENTITY;
            case "BUILD_QUOTA_EXCEEDED" -> HttpStatus.TOO_MANY_REQUESTS;
            case "BUILD_TASK_NOT_FOUND" -> HttpStatus.NOT_FOUND;
            default -> HttpStatus.BAD_REQUEST;
        };
        log.warn("build error {} : {}", e.code(), e.getMessage());
        return ResponseEntity.status(status).body(e.body(traceId));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, Object>> badRequest(IllegalArgumentException e) {
        String traceId = UUID.randomUUID().toString();
        return ResponseEntity.badRequest()
                .body(new BizException("VALIDATION_FAILED", e.getMessage()).body(traceId));
    }
}
