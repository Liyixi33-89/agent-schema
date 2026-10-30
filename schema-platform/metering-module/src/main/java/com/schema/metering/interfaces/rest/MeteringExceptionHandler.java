package com.schema.metering.interfaces.rest;

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
 * 计量域统一错误体（09BE §A.5 HTTP 映射）。
 */
@RestControllerAdvice(basePackages = "com.schema.metering")
public class MeteringExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(MeteringExceptionHandler.class);

    @ExceptionHandler(BizException.class)
    public ResponseEntity<Map<String, Object>> biz(BizException e) {
        String traceId = UUID.randomUUID().toString();
        HttpStatus status = switch (e.code()) {
            case "SIGNATURE_INVALID", "UNAUTHORIZED" -> HttpStatus.UNAUTHORIZED;
            case "EVENT_PAYLOAD_INVALID" -> HttpStatus.UNPROCESSABLE_ENTITY;
            case "QUOTA_EXCEEDED" -> HttpStatus.TOO_MANY_REQUESTS;
            default -> HttpStatus.BAD_REQUEST;
        };
        log.warn("metering error {} : {}", e.code(), e.getMessage());
        return ResponseEntity.status(status).body(e.body(traceId));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, Object>> badRequest(IllegalArgumentException e) {
        String traceId = UUID.randomUUID().toString();
        return ResponseEntity.badRequest()
                .body(new BizException("EVENT_PAYLOAD_INVALID", e.getMessage()).body(traceId));
    }
}
