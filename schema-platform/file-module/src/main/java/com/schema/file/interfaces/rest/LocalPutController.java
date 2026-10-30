package com.schema.file.interfaces.rest;

import com.schema.file.domain.FilePolicy;
import com.schema.file.infrastructure.storage.LocalFsStorage;
import com.schema.file.infrastructure.storage.LocalFsStorage.TokenBinding;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;

/**
 * LocalFs 凭证消费端点（模拟 S3 直传语义，11BE §2 占位实现）：
 * - POST /api/files/local-put/{token}：一次性凭证写入对象（凭证取出即删防重放；
 *   校验过期 / 大小上限 / 类型白名单——模拟 S3 预签名约束）；
 * - GET /api/files/local-get/{token}：下载（强制 attachment + nosniff——存储型 XSS 红线响应头）。
 * 生产态切换 S3StorageImpl 后本端点停用（配置开关），业务代码零改动。
 */
@RestController
public class LocalPutController {

    /** 凭证有效期上限（与 FilePolicy.PUT_EXPIRY 对齐；双端各自校验）。 */
    private static final long TOKEN_TTL_MS = FilePolicy.PUT_EXPIRY.toMillis();

    private final LocalFsStorage storage;

    public LocalPutController(LocalFsStorage storage) {
        this.storage = storage;
    }

    /** 预签名 PUT 消费（multipart 时带 ?part=N 写分块）。 */
    @PostMapping(value = "/api/files/local-put/{token}", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<Void> put(@PathVariable String token,
            @RequestParam(value = "part", required = false) Integer part,
            @RequestBody byte[] body) {
        TokenBinding binding = LocalFsStorage.consumeBinding(token);
        if (binding == null || isExpired(binding)) {
            return ResponseEntity.status(401).build();   // 凭证过期/重放
        }
        // 大小上限约束（单 PUT：声明 size；分块：块大小上限）
        long maxBytes = binding.maxBytes() > 0 ? binding.maxBytes() : FilePolicy.PART_SIZE;
        if (body.length > maxBytes) {
            return ResponseEntity.status(413).build();   // 超预签名大小约束
        }
        if (part != null) {
            // multipart 分块：凭证为 uploadId 形态（peek 保留到 complete）；块号 1..MAX_PARTS
            if (part < 1 || part > FilePolicy.MAX_PARTS) {
                return ResponseEntity.status(400).build();
            }
            storage.writePart(binding.objectKey(), part, body);
        } else {
            storage.write(binding.objectKey(), body);
        }
        return ResponseEntity.ok().build();
    }

    /** 预签名 GET 消费（强制下载语义——svg/html 独立内容域红线，11BE §6）。 */
    @GetMapping("/api/files/local-get/{token}")
    public ResponseEntity<byte[]> get(@PathVariable String token) {
        TokenBinding binding = LocalFsStorage.consumeBinding(token);
        if (binding == null) {
            return ResponseEntity.status(401).build();
        }
        byte[] bytes = storage.read(binding.objectKey());
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"file\"")
                .header("X-Content-Type-Options", "nosniff")
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .body(bytes);
    }

    private static boolean isExpired(TokenBinding binding) {
        return System.currentTimeMillis() - binding.issuedAtEpochMs() > TOKEN_TTL_MS;
    }
}
