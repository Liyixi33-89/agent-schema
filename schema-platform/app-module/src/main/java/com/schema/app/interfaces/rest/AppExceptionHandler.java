package com.schema.app.interfaces.rest;

import com.schema.app.domain.model.NavVersionConflictException;
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
 * 应用域统一错误体（10BE §A.2）：{code, message, traceId, details?}。
 * 包限定 com.schema.app——与 metadata/iam 域 advice 不竞争（同优先级排序不确定的坑，见 metadata advice 注释）。
 * HTTP 映射：NAV_VERSION_CONFLICT/APP_ADMIN_REQUIRED/APP_DELETE_CONFIRM_REQUIRED → 409；
 * APP_NAME_DUPLICATED → 422；APP_LIMIT_EXCEEDED/PERM_DENIED → 403；APP_NOT_FOUND → 404。
 */
@RestControllerAdvice(basePackages = "com.schema.app")
public class AppExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(AppExceptionHandler.class);

    @ExceptionHandler(BizException.class)
    public ResponseEntity<Map<String, Object>> biz(BizException e) {
        String traceId = UUID.randomUUID().toString();
        HttpStatus status = switch (e.code()) {
            case "NAV_VERSION_CONFLICT", "APP_ADMIN_REQUIRED", "APP_DELETE_CONFIRM_REQUIRED" -> HttpStatus.CONFLICT;
            case "APP_NAME_DUPLICATED", "NAV_PAGE_NOT_FOUND" -> HttpStatus.UNPROCESSABLE_ENTITY;
            case "APP_LIMIT_EXCEEDED", "PERM_DENIED" -> HttpStatus.FORBIDDEN;
            case "APP_NOT_FOUND" -> HttpStatus.NOT_FOUND;
            default -> HttpStatus.BAD_REQUEST;
        };
        if (status.is5xxServerError()) {
            log.error("biz error {}", e.code(), e);
        } else {
            log.warn("biz error {} : {}", e.code(), e.getMessage());
        }
        return ResponseEntity.status(status).body(e.body(traceId));
    }

    @ExceptionHandler(NavVersionConflictException.class)
    public ResponseEntity<Map<String, Object>> navConflict(NavVersionConflictException e) {
        String traceId = UUID.randomUUID().toString();
        BizException biz = new BizException("NAV_VERSION_CONFLICT", e.getMessage(),
                Map.of("serverVersion", e.currentVersion()));
        return ResponseEntity.status(HttpStatus.CONFLICT).body(biz.body(traceId));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, Object>> badRequest(IllegalArgumentException e) {
        String traceId = UUID.randomUUID().toString();
        return ResponseEntity.badRequest().body(
                new BizException("VALIDATION_FAILED", e.getMessage()).body(traceId));
    }
}