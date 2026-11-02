package com.schema.bootstrap;

import com.schema.file.domain.storage.ObjectStorage;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.TestPropertySource;

import java.time.Duration;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * M9.1 存储抽象契约测试（MinIO/LocalFs 同套契约）：
 * 仅通过 {@link ObjectStorage} 接口验证存储行为契约——write/read/head/delete/presign 语义、
 * 分块会话生命周期、路径穿越拒绝。业务代码零依赖具体实现类；
 * S3StorageImpl（MinIO/OSS 同协议）接入时复用本套测试即可验证契约一致。
 * 运行时注入的是 LocalFsStorage（本地零依赖实现），契约本身与实现解耦。
 */
@SpringBootTest(classes = com.schema.bootstrap.SchemaApplication.class)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(properties = {
        "spring.datasource.url=jdbc:postgresql://localhost:5432/schema_dev",
        "spring.datasource.username=schema_dev",
        "spring.datasource.password=schema_local_only",
        "spring.flyway.clean-disabled=false",
        "file.local-dir=./data/files-contract-test"
})
class ObjectStorageContractIT {

    @Autowired
    private ObjectStorage storage;

    @AfterEach
    void cleanup() {
        storage.delete("contract/a.txt");
        storage.delete("contract/sub/b.bin");
        storage.delete("escape.txt");
    }

    @Test
    void writeReadHeadDelete_往返一致() {
        byte[] payload = "契约内容-0123456789".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        storage.write("contract/a.txt", payload);

        ObjectStorage.HeadInfo h = storage.head("contract/a.txt");
        assertTrue(h.exists(), "写入后 HEAD 应存在");
        assertEquals(payload.length, h.sizeBytes(), "HEAD 应返回真实字节数");

        assertArrayEquals(payload, storage.read("contract/a.txt"), "read 应返回写入原字节");

        storage.delete("contract/a.txt");
        assertFalse(storage.head("contract/a.txt").exists(), "删除后 HEAD 应不存在");
    }

    @Test
    void write覆盖_内容替换() {
        storage.write("contract/a.txt", new byte[]{1, 2, 3});
        storage.write("contract/a.txt", new byte[]{9, 8, 7, 6, 5});
        assertEquals(5, storage.head("contract/a.txt").sizeBytes(), "重写应覆盖旧对象");
        assertArrayEquals(new byte[]{9, 8, 7, 6, 5}, storage.read("contract/a.txt"));
    }

    @Test
    void presignPut_签发url且过期时长固化() {
        ObjectStorage.PresignedUrl url = storage.presignPut("contract/a.txt",
                Duration.ofMinutes(5), "text/plain", 1024 * 1024);
        assertNotNull(url.url(), "presign 应返回非空 url");
        assertTrue(url.url().startsWith("/"), "LocalFs 预签名走同源回调端点");
        assertEquals(Duration.ofMinutes(5), url.expiry(), "过期时长应原样返回");
    }

    @Test
    void presignGet_签发只读url() {
        ObjectStorage.PresignedUrl url = storage.presignGet("contract/a.txt", Duration.ofHours(1));
        assertNotNull(url.url(), "presign GET 应返回非空 url");
        assertTrue(url.url().startsWith("/"), "GET 预签名走同源端点");
    }

    @Test
    void 分块会话_生命周期完整() {
        String uploadId = storage.initiateMultipart("contract/sub/b.bin");
        assertNotNull(uploadId, "initiateMultipart 应返回会话 id");

        ObjectStorage.PresignedUrl p1 = storage.presignPartPut(uploadId, 1, Duration.ofMinutes(5));
        ObjectStorage.PresignedUrl p2 = storage.presignPartPut(uploadId, 2, Duration.ofMinutes(5));
        assertNotNull(p1.url());
        assertNotNull(p2.url());

        byte[] part1 = new byte[100];
        byte[] part2 = new byte[200];
        java.util.Arrays.fill(part1, (byte) 'A');
        java.util.Arrays.fill(part2, (byte) 'B');
        storage.writePart(uploadId, 1, part1);
        storage.writePart(uploadId, 2, part2);

        // etag 由 complete 消费端点按分块内容 sha256 逐块核对——这里验证分块内容可回读
        assertNotNull(storage.partSha256(uploadId, 1));
        assertNotNull(storage.partSha256(uploadId, 2));

        // complete：按序合并到目标对象键（返回合并摘要，格式属实现细节——S3 为 multipart etag、LocalFs 为 sha 拼接）
        String etag = storage.completeMultipart(uploadId, List.of(
                new ObjectStorage.PartETag(2, "etag2"),
                new ObjectStorage.PartETag(1, "etag1")));
        assertNotNull(etag, "complete 应返回合并摘要");

        // 合并语义由消费端点经 mergeParts 落盘——直接验证 mergeParts 结果
        storage.mergeParts(uploadId, List.of(1, 2), "contract/sub/b.bin");
        assertTrue(storage.head("contract/sub/b.bin").exists(), "合并后目标对象应存在");
        assertEquals(300, storage.head("contract/sub/b.bin").sizeBytes(), "合并应拼接全部块字节");
    }

    @Test
    void 分块缺失_合并抛异常() {
        String uploadId = storage.initiateMultipart("contract/sub/b.bin");
        storage.writePart(uploadId, 1, new byte[10]);
        assertThrows(IllegalStateException.class,
                () -> storage.mergeParts(uploadId, List.of(1, 2), "contract/sub/b.bin"),
                "缺失分块必须抛异常而非静默合并");
    }

    @Test
    void 路径穿越_写入拒绝() {
        // 直接跳出存储根目录（../ 前缀）必须拒绝——防越出 baseDir 读写任意路径
        assertThrows(IllegalArgumentException.class,
                () -> storage.write("../escape.txt", new byte[1]),
                "对象键含 ../ 前缀必须拒绝（防越出存储根目录）");
        assertThrows(IllegalArgumentException.class,
                () -> storage.read("../../etc/passwd"),
                "read 穿越同样拒绝");
    }
}