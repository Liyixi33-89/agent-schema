package com.schema.file.infrastructure.storage;

import com.schema.file.domain.storage.ObjectStorage;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;

import com.schema.file.domain.storage.ObjectStorage;

/**
 * 本地文件系统实现（11BE §2 占位 LocalFsStorageImpl）：
 * 本地开发零依赖启动；预签名 URL 以「同源回调端点 + 一次性凭证」模拟 S3 语义——
 * presign 返回 {PUT /api/files/local-put/{token}}，LocalPutController 消费 token 执行真实写入。
 * 生产态由 S3StorageImpl（MinIO/OSS 同协议）替换，业务代码零改动（接口化红线）。
 */
@Component
public class LocalFsStorage implements ObjectStorage {

    private final Path baseDir;
    private final SecureRandom random = new SecureRandom();

    public LocalFsStorage(@Value("${file.local-dir:./data/files}") String dir) {
        // 先绝对化再比对——resolve 后 normalize 的路径必须以同一形态的 baseDir 为前缀
        this.baseDir = Path.of(dir).toAbsolutePath().normalize();
        try {
            Files.createDirectories(baseDir);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @Override
    public PresignedUrl presignPut(String objectKey, Duration expiry, String contentType, long maxSize) {
        // LocalFs：一次性上传凭证（token 绑定 objectKey + 过期时刻 + 大小上限 + 类型；真实上传经 LocalPutController）
        String token = issueToken(objectKey, maxSize, contentType);
        return new PresignedUrl("/api/files/local-put/" + token, expiry);
    }

    @Override
    public PresignedUrl presignGet(String objectKey, Duration expiry) {
        String token = issueToken(objectKey);
        return new PresignedUrl("/api/files/local-get/" + token, expiry);
    }

    @Override
    public String initiateMultipart(String objectKey) {
        return "mp-" + issueToken(objectKey);
    }

    @Override
    public PresignedUrl presignPartPut(String uploadId, int partNumber, Duration expiry) {
        return new PresignedUrl("/api/files/local-put/" + uploadId + "?part=" + partNumber, expiry);
    }

    @Override
    public String completeMultipart(String uploadId, List<PartETag> parts) {
        // 已传块按序合并；etag = 分块文件 sha256 前缀（LocalFs 校验语义）
        List<PartETag> sorted = new ArrayList<>(parts);
        sorted.sort(Comparator.comparingInt(PartETag::partNumber));
        StringBuilder etag = new StringBuilder();
        for (PartETag p : sorted) {
            etag.append(p.etag(), 0, Math.min(8, p.etag().length()));
        }
        return etag.toString();
    }

    @Override
    public void delete(String objectKey) {
        try {
            Files.deleteIfExists(resolve(objectKey));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @Override
    public HeadInfo head(String objectKey) {
        Path p = resolve(objectKey);
        if (!Files.exists(p)) {
            return new HeadInfo(false, 0);
        }
        try {
            return new HeadInfo(true, Files.size(p));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @Override
    public byte[] read(String objectKey) {
        try {
            return Files.readAllBytes(resolve(objectKey));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @Override
    public void write(String objectKey, byte[] bytes) {
        try {
            Path p = resolve(objectKey);
            Files.createDirectories(p.getParent());
            Path tmp = p.resolveSibling(p.getFileName() + ".tmp-" + random.nextInt(1_000_000));
            Files.write(tmp, bytes);
            try {
                Files.move(tmp, p, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException retry) {
                Files.move(tmp, p, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** 分块写入（multipart part 消费端点用）。 */
    @Override
    public void writePart(String uploadId, int partNumber, byte[] bytes) {
        try {
            Path partDir = baseDir.resolve("_uploads").resolve(uploadId);
            Files.createDirectories(partDir);
            Files.write(partDir.resolve("part-" + partNumber), bytes);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** 分块合并（multipart complete 消费端点用）。 */
    @Override
    public void mergeParts(String uploadId, List<Integer> partNumbers, String targetObjectKey) {
        try {
            Path partDir = baseDir.resolve("_uploads").resolve(uploadId);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            for (int n : partNumbers) {
                out.write(Files.readAllBytes(partDir.resolve("part-" + n)));
            }
            write(targetObjectKey, out.toByteArray());
            // 合并后清理分块目录
            try (var walk = Files.walk(partDir)) {
                walk.sorted(Comparator.reverseOrder()).forEach(p -> {
                    try {
                        Files.deleteIfExists(p);
                    } catch (IOException ignored) {
                    }
                });
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** 上传凭证 → objectKey 映射（内存态一次性；重启丢失属可接受降级——前端重试重新 presign）。
     *  凭证绑定约束：objectKey + 签发时刻（LocalPutController 消费时校验过期与大小上限）。 */
    private static final java.util.concurrent.ConcurrentHashMap<String, TokenBinding> TOKENS =
            new java.util.concurrent.ConcurrentHashMap<>();

    /** 凭证绑定信息（过期校验 + 大小上限——模拟 S3 预签名约束语义）。 */
    public record TokenBinding(String objectKey, long issuedAtEpochMs, long maxBytes, String contentType) {}

    private String issueToken(String objectKey) {
        return issueToken(objectKey, -1, null);
    }

    private String issueToken(String objectKey, long maxBytes, String contentType) {
        byte[] raw = new byte[24];
        random.nextBytes(raw);
        String token = HexFormat.of().formatHex(raw);
        TOKENS.put(token, new TokenBinding(objectKey, System.currentTimeMillis(), maxBytes, contentType));
        return token;
    }

    /** 消费凭证换取绑定（一次性——取出即删防重放）；null = 不存在。 */
    public static TokenBinding consumeBinding(String token) {
        return TOKENS.remove(token);
    }

    /** multipart 凭证绑定查询（完整保留到 complete）。 */
    public static TokenBinding peekBinding(String uploadId) {
        return TOKENS.get(uploadId);
    }

    private Path resolve(String objectKey) {
        // 防路径穿越：规范化后必须仍在 baseDir 下
        Path p = baseDir.resolve(objectKey).normalize();
        if (!p.startsWith(baseDir)) {
            throw new IllegalArgumentException("非法对象键");
        }
        return p;
    }

    /** 分块内容 sha256（etag 语义）。 */
    public static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
