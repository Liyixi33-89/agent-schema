package com.schema.iam.interfaces.rest;

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
 * IAM 域统一错误体（10BE §A.2 + 03BE §A.4 HTTP 映射）。
 */
@RestControllerAdvice(basePackages = "com.schema.iam")
public class IamExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(IamExceptionHandler.class);

    @ExceptionHandler(BizException.class)
    public ResponseEntity<Map<String, Object>> biz(BizException e) {
        String traceId = UUID.randomUUID().toString();
        HttpStatus status = switch (e.code()) {
            case "UNAUTHORIZED", "REFRESH_REVOKED" -> HttpStatus.UNAUTHORIZED;
            case "ACCOUNT_LOCKED" -> HttpStatus.LOCKED;   // 423
            case "TENANT_MISMATCH", "PERM_DENIED", "PASSWORD_CHANGE_REQUIRED" -> HttpStatus.FORBIDDEN;
            case "USER_NOT_FOUND", "ROLE_NOT_FOUND" -> HttpStatus.NOT_FOUND;
            default -> HttpStatus.BAD_REQUEST;
        };
        log.warn("iam error {} : {}", e.code(), e.getMessage());
        return ResponseEntity.status(status).body(e.body(traceId));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, Object>> badRequest(IllegalArgumentException e) {
        String traceId = UUID.randomUUID().toString();
        return ResponseEntity.badRequest()
                .body(new BizException("VALIDATION_FAILED", e.getMessage()).body(traceId));
    }
}
