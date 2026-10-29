package com.schema.data.interfaces.rest;

import com.schema.platform.common.web.BizException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * 数据域异常映射（02BE §A.6）：FILTER_OPERATOR_INVALID/FIELD_DELETED/PAGE_TOO_DEEP → 400；
 * RECORD_NOT_FOUND → 404（BizException.notFound）；VALIDATION_FAILED → 422。
 * 包限定 basePackages——与 IAM/metadata/page 域 advice 不竞争（03BE 沉淀）。
 */
@RestControllerAdvice(basePackages = "com.schema.data")
public class DataExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(DataExceptionHandler.class);

    @ExceptionHandler(BizException.class)
    public ResponseEntity<Map<String, Object>> biz(BizException e) {
        String traceId = UUID.randomUUID().toString();
        HttpStatus status = switch (e.code()) {
            case "FILTER_OPERATOR_INVALID", "FIELD_DELETED", "PAGE_TOO_DEEP" -> HttpStatus.BAD_REQUEST;
            case "RECORD_NOT_FOUND" -> HttpStatus.NOT_FOUND;
            case "VALIDATION_FAILED" -> HttpStatus.UNPROCESSABLE_ENTITY;
            case "PERM_DENIED", "PREVIEW_SCOPE_DENIED" -> HttpStatus.FORBIDDEN;
            default -> HttpStatus.BAD_REQUEST;
        };
        if (status.is5xxServerError()) {
            log.error("data error {}: {}", e.code(), e.getMessage(), e);
        } else {
            log.info("data error {}: {}", e.code(), e.getMessage());
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.put("traceId", traceId);
        return ResponseEntity.status(status).body(body);
    }
}
