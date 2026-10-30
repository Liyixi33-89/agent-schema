package com.schema.file.interfaces.rest;

import com.schema.file.infrastructure.storage.LocalFsStorage;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * LocalFs 凭证消费端点（模拟 S3 直传语义，11BE §2 占位实现）：
 * - PUT /api/files/local-put/{token}：一次性凭证写入对象（凭证取出即删防重放）；
 * - GET /api/files/local-get/{token}：下载（强制 attachment + nosniff——存储型 XSS 红线响应头）。
 * 生产态切换 S3StorageImpl 后本端点停用（配置开关），业务代码零改动。
 */
@RestController
public class LocalPutController {

    private final LocalFsStorage storage;

    public LocalPutController(LocalFsStorage storage) {
        this.storage = storage;
    }

    /** 预签名 PUT 消费（multipart 时带 ?part=N 写分块）。 */
    @PostMapping(value = "/api/files/local-put/{token}", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<Void> put(@PathVariable String token,
            @RequestParam(value = "part", required = false) Integer part,
            @RequestBody byte[] body) {
        String objectKey = LocalFsStorage.consumeToken(token);
        if (objectKey == null) {
            return ResponseEntity.status(401).build();   // 凭证过期/重放
        }
        String partTarget = LocalFsStorage.peekUploadTarget(token);
        if (part != null && partTarget != null) {
            storage.writePart(partTarget, part, body);
        } else if (part != null) {
            storage.writePart(objectKey, part, body);
        } else {
            storage.write(objectKey, body);
        }
        return ResponseEntity.ok().build();
    }

    /** 预签名 GET 消费（强制下载语义——svg/html 独立内容域红线，11BE §6）。 */
    @GetMapping("/api/files/local-get/{token}")
    public ResponseEntity<byte[]> get(@PathVariable String token) {
        String objectKey = LocalFsStorage.consumeToken(token);
        if (objectKey == null) {
            return ResponseEntity.status(401).build();
        }
        byte[] bytes = storage.read(objectKey);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"file\"")
                .header("X-Content-Type-Options", "nosniff")
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .body(bytes);
    }
}
