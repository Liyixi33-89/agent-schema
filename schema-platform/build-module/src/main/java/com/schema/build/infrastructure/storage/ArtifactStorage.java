package com.schema.build.infrastructure.storage;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 产物存储（04BE §2.3④）：artifacts/{tenantId}/{contentHash}.js 本地目录实现。
 * contentHash 命名天然去重与不可变（同代码多次保存不产生新对象）；
 * 生产态由对象存储（MinIO/OSS 同协议）替换，调用方零改动。
 */
@Component
public class ArtifactStorage {

    private final Path baseDir;

    public ArtifactStorage(@Value("${build.artifact-dir:./data/artifacts}") String dir) {
        this.baseDir = Path.of(dir).toAbsolutePath().normalize();
        try {
            Files.createDirectories(baseDir);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** 写产物（幂等：同 hash 已存在跳过——内容不可变）。 */
    public void write(long tenantId, String contentHash, byte[] bytes) {
        try {
            Path p = objectPath(tenantId, contentHash);
            if (Files.exists(p)) return;
            Files.createDirectories(p.getParent());
            Path tmp = p.resolveSibling(p.getFileName() + ".tmp");
            Files.write(tmp, bytes);
            Files.move(tmp, p, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public byte[] read(long tenantId, String contentHash) {
        try {
            return Files.readAllBytes(objectPath(tenantId, contentHash));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public boolean exists(long tenantId, String contentHash) {
        return Files.exists(objectPath(tenantId, contentHash));
    }

    private Path objectPath(long tenantId, String contentHash) {
        Path p = baseDir.resolve("artifacts").resolve(String.valueOf(tenantId))
                .resolve(contentHash + ".js").normalize();
        if (!p.startsWith(baseDir)) {
            throw new IllegalArgumentException("非法产物键");
        }
        return p;
    }
}
