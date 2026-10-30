package com.schema.file.interfaces.rest;

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
 * 文件域统一错误体（11BE §A.3 HTTP 映射）。
 */
@RestControllerAdvice(basePackages = "com.schema.file")
public class FileExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(FileExceptionHandler.class);

    @ExceptionHandler(BizException.class)
    public ResponseEntity<Map<String, Object>> biz(BizException e) {
        String traceId = UUID.randomUUID().toString();
        HttpStatus status = switch (e.code()) {
            case "FILE_TYPE_FORBIDDEN" -> HttpStatus.BAD_REQUEST;
            case "FILE_TOO_LARGE" -> HttpStatus.PAYLOAD_TOO_LARGE;       // 413
            case "FILE_NOT_FOUND" -> HttpStatus.NOT_FOUND;               // 404（跨租户同响应）
            case "FILE_EXPIRED" -> HttpStatus.GONE;                      // 410
            case "UPLOAD_MISMATCH" -> HttpStatus.CONFLICT;               // 409
            default -> HttpStatus.BAD_REQUEST;
        };
        log.warn("file error {} : {}", e.code(), e.getMessage());
        return ResponseEntity.status(status).body(e.body(traceId));
    }
}
