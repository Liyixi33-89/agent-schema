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

/**
 * 本地文件系统实现（11BE §2 占位 LocalFsStorageImpl）：
 * 本地开发零依赖启动；预签名 URL 以「同源回调端点 + 一次性凭证」模拟 S3 语义——
 * presign 返回 {PUT /api/files/local-put/{token}}，LocalPutController 消费 token 执行真实写入。
 * 生产态由 S3StorageImpl（MinIO/OSS 同协议）替换，业务代码零改动（接口化红线）。
 *
 * 凭证绑定（2026-10-30 FIX-M9 收口）：
 * - op ∈ {PUT, GET, SESSION, PART}——PUT/GET 严格隔离，凭证不得跨操作混用；
 * - 过期时长签发时固化进绑定（expiry 不再依赖消费侧时钟口径），过期即拒；
 * - PUT/PART 一次性消费（防重放）；SESSION 与 PART 绑定保留至 complete；
 * - SESSION.objectKey = 目标对象键；PART.objectKey = uploadId（写分块目录用）。
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
        String token = issueToken(Op.PUT, objectKey, expiry.toMillis(), maxSize, contentType);
        return new PresignedUrl("/api/files/local-put/" + token, expiry);
    }

    @Override
    public PresignedUrl presignGet(String objectKey, Duration expiry) {
        String token = issueToken(Op.GET, objectKey, expiry.toMillis(), -1, null);
        return new PresignedUrl("/api/files/local-get/" + token, expiry);
    }

    @Override
    public String initiateMultipart(String objectKey) {
        // 会话凭证绑定目标对象键（合并阶段经 peek 取回）；过期沿用 PUT 时效
        return issueToken(Op.SESSION, objectKey, Duration.ofMinutes(60).toMillis(), -1, null);
    }

    @Override
    public PresignedUrl presignPartPut(String uploadId, int partNumber, Duration expiry) {
        TokenBinding session = peekBinding(uploadId);
        if (session == null || session.op() != Op.SESSION
                || partNumber < 1 || partNumber > 10_000) {
            throw new IllegalArgumentException("非法分块会话或块号");
        }
        // 分块凭证绑定 uploadId（消费端写入 _uploads/{uploadId} 目录）；块号由消费端点校验
        String token = issueToken(Op.PART, uploadId, expiry.toMillis(), 8L * 1024 * 1024, null);
        return new PresignedUrl("/api/files/local-put/" + token + "?part=" + partNumber, expiry);
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

    /** 分块内容摘要（complete 逐块核对 etag；块缺失返回 null）。 */
    @Override
    public String partSha256(String uploadId, int partNumber) {
        Path part = baseDir.resolve("_uploads").resolve(uploadId).resolve("part-" + partNumber);
        if (!Files.exists(part)) {
            return null;
        }
        try {
            return sha256(Files.readAllBytes(part));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** 分块合并（multipart complete 消费端点用）；缺失分块抛异常而非静默合并。 */    @Override
    public void mergeParts(String uploadId, List<Integer> partNumbers, String targetObjectKey) {
        try {
            Path partDir = baseDir.resolve("_uploads").resolve(uploadId);
            for (int n : partNumbers) {
                if (!Files.exists(partDir.resolve("part-" + n))) {
                    throw new IllegalStateException("分块缺失: " + n);
                }
            }
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

    /** 上传凭证 → 绑定映射（内存态；重启丢失属可接受降级——前端重试重新 presign）。
     *  PUT/PART 取出即删防重放；SESSION/PART 保留至 complete 后清理。 */
    private static final java.util.concurrent.ConcurrentHashMap<String, TokenBinding> TOKENS =
            new java.util.concurrent.ConcurrentHashMap<>();

    /** 凭证操作类型：PUT/GET 严格隔离；SESSION=分块会话；PART=分块写入凭证。 */
    public enum Op { PUT, GET, SESSION, PART }

    /** 凭证绑定（op 隔离 + 签发即固化过期时刻 + 大小/类型约束——模拟 S3 预签名语义）。 */
    public record TokenBinding(Op op, String objectKey, long issuedAtEpochMs, long expiresAtEpochMs,
            long maxBytes, String contentType) {
        public boolean expired() {
            return System.currentTimeMillis() > expiresAtEpochMs;
        }
    }

    private String issueToken(Op op, String objectKey, long ttlMs, long maxBytes, String contentType) {
        byte[] raw = new byte[24];
        random.nextBytes(raw);
        String token = HexFormat.of().formatHex(raw);
        long now = System.currentTimeMillis();
        TOKENS.put(token, new TokenBinding(op, objectKey, now, now + ttlMs, maxBytes, contentType));
        return token;
    }

    /** 一次性消费（PUT/PART 防重放）；null = 不存在。 */
    public static TokenBinding consumeBinding(String token) {
        return TOKENS.remove(token);
    }

    /** 绑定查询（SESSION 会话与未过期校验用）；null = 不存在。 */
    public static TokenBinding peekBinding(String token) {
        return TOKENS.get(token);
    }

    /** complete 后清理会话与全部分块凭证。 */
    public static void releaseSession(String uploadId) {
        TOKENS.keySet().removeIf(k -> {
            TokenBinding b = TOKENS.get(k);
            return b != null && b.op() == Op.PART && uploadId.equals(b.objectKey());
        });
        TOKENS.remove(uploadId);
    }

    /** 会话过期回收（防凭证表无限膨胀；过期 SESSION 及其 PART 一并清除）。 */
    public static void evictExpired() {
        TOKENS.entrySet().removeIf(e -> e.getValue().expired());
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
