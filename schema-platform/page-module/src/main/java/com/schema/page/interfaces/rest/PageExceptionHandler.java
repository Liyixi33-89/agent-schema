package com.schema.page.interfaces.rest;

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
 * 页面域统一错误体（10BE §A.2 / 04BE §A.6）。
 * 包限定 com.schema.page——多 advice 共存时无包限定会与 IAM/metadata 域竞争解析（M3 实证教训）。
 * HTTP 映射：DRAFT_VERSION_CONFLICT/PUBLISH_CONFLICT → 409；PATH_DUPLICATED/PAGE_VALIDATION_FAILED → 422；
 * PAGE_NOT_FOUND/RELEASE_ROLLED_BACK → 404；GRANT_CONSUMED/PREVIEW_SESSION_REVOKED → 401；
 * PERM_DENIED/PREVIEW_SCOPE_DENIED → 403；认证类已由 IAM 域 advice 处理。
 */
@RestControllerAdvice(basePackages = "com.schema.page")
public class PageExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(PageExceptionHandler.class);

    @ExceptionHandler(BizException.class)
    public ResponseEntity<Map<String, Object>> biz(BizException e) {
        String traceId = UUID.randomUUID().toString();
        HttpStatus status = switch (e.code()) {
            case "DRAFT_VERSION_CONFLICT", "PUBLISH_CONFLICT" -> HttpStatus.CONFLICT;
            case "PATH_DUPLICATED", "PAGE_VALIDATION_FAILED", "PAGE_KEY_DUPLICATED" ->
                    HttpStatus.UNPROCESSABLE_ENTITY;
            case "PAGE_NOT_FOUND", "RELEASE_ROLLED_BACK" -> HttpStatus.NOT_FOUND;
            case "GRANT_CONSUMED", "PREVIEW_SESSION_REVOKED" -> HttpStatus.UNAUTHORIZED;
            case "PERM_DENIED", "PREVIEW_SCOPE_DENIED" -> HttpStatus.FORBIDDEN;
            default -> HttpStatus.BAD_REQUEST;
        };
        log.warn("biz error {} : {}", e.code(), e.getMessage());
        return ResponseEntity.status(status).body(e.body(traceId));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, Object>> badRequest(IllegalArgumentException e) {
        String traceId = UUID.randomUUID().toString();
        return ResponseEntity.badRequest().body(new BizException("VALIDATION_FAILED", e.getMessage()).body(traceId));
    }
}
