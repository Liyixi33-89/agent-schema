package com.schema.metadata.interfaces.rest;

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
 * 统一错误体（10BE §A.2）：{code, message, traceId, details?}。
 * HTTP 映射：MODEL_VERSION_CONFLICT → 409；CONFIRM_TOKEN_INVALID/FIELD_KEY_IMMUTABLE/CIRCULAR_DEPENDENCY → 422；
 * MODEL_LIMIT_EXCEEDED → 403；*_NOT_FOUND → 404；其余业务异常 → 400。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    @ExceptionHandler(BizException.class)
    public ResponseEntity<Map<String, Object>> biz(BizException e) {
        String traceId = UUID.randomUUID().toString();
        HttpStatus status = switch (e.code()) {
            case "MODEL_VERSION_CONFLICT" -> HttpStatus.CONFLICT;
            case "CONFIRM_TOKEN_INVALID", "FIELD_KEY_IMMUTABLE", "CIRCULAR_DEPENDENCY", "ROLLBACK_NOOP" ->
                    HttpStatus.UNPROCESSABLE_ENTITY;
            case "MODEL_LIMIT_EXCEEDED" -> HttpStatus.FORBIDDEN;
            case "MODEL_NOT_FOUND" -> HttpStatus.NOT_FOUND;
            default -> HttpStatus.BAD_REQUEST;
        };
        if (status.is5xxServerError()) {
            log.error("biz error {}", e.code(), e);
        } else {
            log.warn("biz error {} : {}", e.code(), e.getMessage());
        }
        return ResponseEntity.status(status).body(e.body(traceId));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, Object>> badRequest(IllegalArgumentException e) {
        String traceId = UUID.randomUUID().toString();
        return ResponseEntity.badRequest().body(new BizException("VALIDATION_FAILED", e.getMessage()).body(traceId));
    }
}
