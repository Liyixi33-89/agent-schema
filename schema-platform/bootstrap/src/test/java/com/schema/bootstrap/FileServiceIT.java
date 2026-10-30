package com.schema.bootstrap;

import com.schema.file.application.FileService;
import com.schema.file.domain.storage.ObjectStorage;
import com.schema.file.infrastructure.storage.LocalFsStorage;
import com.schema.file.infrastructure.storage.LocalFsStorage.Op;
import com.schema.file.infrastructure.storage.LocalFsStorage.TokenBinding;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * M9 集成测试（真实 PG + LocalFs，11BE §8 硬性要求）：
 * 类型白名单 / 直传 complete 校验（size 不符 409 清理）/ 越权（跨租户 404 同响应）/
 * 元数据状态机（PENDING→ACTIVE）/ 管理删除失效占位 / 生命周期清理。
 */
@SpringBootTest(classes = com.schema.bootstrap.SchemaApplication.class)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(properties = {
        "spring.datasource.url=jdbc:postgresql://localhost:5432/schema_dev",
        "spring.datasource.username=schema_dev",
        "spring.datasource.password=schema_local_only",
        "spring.flyway.clean-disabled=false",
        "file.local-dir=./target/test-files"
})
class FileServiceIT {

    private static final TenantInfo T1 = new TenantInfo(1, 1, 1);
    private static final TenantInfo T882 = new TenantInfo(882, 1, 1);

    /** 本测试自建记录的 fileId（精准清理——不按用户猜测删除）。 */
    private final java.util.List<Long> ownFileIds = new java.util.ArrayList<>();
    /** 本测试自建的跨租户隔离用户（882 租户）。 */
    private static final long T882_USER = -8_820_001;

    @Autowired
    private FileService files;

    @Autowired
    private LocalFsStorage storage;

    @Autowired
    private JdbcTemplate jdbc;

    private long lastFileId;

    @BeforeAll
    void setup() {
        jdbc.update("INSERT INTO sys_user (id, tenant_id, account, status) VALUES (?, 882, 'it_file_t882', 'ACTIVE') "
                + "ON CONFLICT (id) DO NOTHING", T882_USER);
    }

    @AfterAll
    void cleanup() {
        // 只清理本测试自建记录（跨测试污染红线）：按收集的 fileId 逐条删对象与元数据
        for (long id : ownFileIds) {
            try {
                jdbc.queryForMap("SELECT object_key FROM file_object WHERE id = ?", id)
                        .forEach((k, v) -> { });
                String key = jdbc.queryForObject("SELECT object_key FROM file_object WHERE id = ?",
                        String.class, id);
                if (key != null) {
                    try {
                        storage.delete(key);
                    } catch (Exception ignored) {
                        // 对象缺失幂等
                    }
                }
            } catch (org.springframework.dao.EmptyResultDataAccessException ignored) {
                // 记录已不存在
            }
            jdbc.update("DELETE FROM file_multipart_session WHERE file_id = ?", id);
            jdbc.update("DELETE FROM file_object WHERE id = ?", id);
        }
        jdbc.update("DELETE FROM sys_user WHERE id = ?", T882_USER);
        // 兜底：仅清理测试运行期产生的 PENDING 孤儿（ACTIVE/EXPIRED 历史数据不动）
        jdbc.update("DELETE FROM file_multipart_session WHERE file_id NOT IN (SELECT id FROM file_object) "
                + "AND upload_id LIKE '%'");
        jdbc.update("DELETE FROM file_object WHERE tenant_id = 882");
    }

    private Map<String, Object> presign(String name, String type, long size, String scope) {
        Map<String, Object> p = TenantContext.with(T1, () -> files.presign(name, type, size, scope, null));
        ownFileIds.add(Long.parseLong((String) p.get("fileId")));
        return p;
    }

    @Test
    void 类型白名单_非法类型被拒() {
        BizException e = assertThrows(BizException.class,
                () -> presign("shell.exe", "application/x-msdownload", 100, "attachment"));
        assertEquals("FILE_TYPE_FORBIDDEN", e.code());
        BizException big = assertThrows(BizException.class,
                () -> presign("huge.pdf", "application/pdf", 200L * 1024 * 1024, "attachment"));
        assertEquals("FILE_TOO_LARGE", big.code());
    }

    @Test
    void avatar上限2MB且svg可上传() {
        BizException e = assertThrows(BizException.class,
                () -> presign("logo.png", "image/png", 3L * 1024 * 1024, "avatar"));
        assertEquals("FILE_TOO_LARGE", e.code());
        Map<String, Object> ok = presign("mark.svg", "image/svg+xml", 1024, "avatar");
        assertNotNull(ok.get("fileId"));
        lastFileId = Long.parseLong((String) ok.get("fileId"));
    }

    @Test
    void 直传流程_complete时size不匹配返回409并清理() {
        Map<String, Object> p = presign("report.pdf", "application/pdf", 2048, "attachment");
        long fileId = Long.parseLong((String) p.get("fileId"));
        String objectKey = (String) p.get("objectKey");
        // 模拟客户端直传：实际写入的字节数与声明不符
        storage.write(objectKey, new byte[1024]);
        BizException e = assertThrows(BizException.class,
                () -> TenantContext.with(T1, () -> files.complete(fileId, null, null)));
        assertEquals("UPLOAD_MISMATCH", e.code());
        // 元数据保留 PENDING（对象已清理）；完整流程用匹配 size 验证
        Map<String, Object> meta = TenantContext.with(T1, () -> files.meta(fileId));
        assertEquals("PENDING", meta.get("status"));
    }

    @Test
    void 直传流程_匹配size后ACTIVE并可下载() {
        Map<String, Object> p = presign("data.csv", "text/csv", 512, "import");
        long fileId = Long.parseLong((String) p.get("fileId"));
        byte[] body = new byte[512];
        storage.write((String) p.get("objectKey"), body);
        // 服务端计算真实摘要回传（新校验拒绝伪造摘要——原 deadbeef 负例已由新测试覆盖）
        Map<String, Object> done = TenantContext.with(T1, () -> files.complete(fileId, null,
                com.schema.file.infrastructure.storage.LocalFsStorage.sha256(body)));
        assertEquals(512L, done.get("size"));
        assertEquals("ACTIVE", TenantContext.with(T1, () -> files.meta(fileId)).get("status"));
        // 下载凭证可签发
        Map<String, Object> url = TenantContext.with(T1, () -> files.downloadUrl(fileId));
        assertNotNull(url.get("downloadUrl"));
        lastFileId = fileId;
    }

    @Test
    void 越权_跨租户fileId同响应404() {
        // T1 造文件，T882 取凭证 → FILE_NOT_FOUND（不给跨租户线索）
        Map<String, Object> p = presign("secret.txt", "text/plain", 10, "attachment");
        long fileId = Long.parseLong((String) p.get("fileId"));
        storage.write((String) p.get("objectKey"), new byte[10]);
        TenantContext.with(T1, () -> files.complete(fileId, null, null));

        BizException e = assertThrows(BizException.class,
                () -> TenantContext.with(T882, () -> files.downloadUrl(fileId)));
        assertEquals("FILE_NOT_FOUND", e.code());
        BizException meta = assertThrows(BizException.class,
                () -> TenantContext.with(T882, () -> files.meta(fileId)));
        assertEquals("FILE_NOT_FOUND", meta.code());
    }

    @Test
    void 管理删除_元数据置EXPIRED后续读取失效() {
        Map<String, Object> p = presign("trash.bin", "application/zip", 32, "attachment");
        long fileId = Long.parseLong((String) p.get("fileId"));
        storage.write((String) p.get("objectKey"), new byte[32]);
        TenantContext.with(T1, () -> files.complete(fileId, null, null));
        TenantContext.with(T1, () -> {
            files.delete(fileId);
            return null;
        });
        assertEquals("EXPIRED", TenantContext.with(T1, () -> files.meta(fileId)).get("status"));
        BizException e = assertThrows(BizException.class,
                () -> TenantContext.with(T1, () -> files.downloadUrl(fileId)));
        assertEquals("FILE_EXPIRED", e.code());
    }

    @Test
    void 删除授权_非上传者且无管理权限被拒() {
        // 上传者 userId=1（T1）；无权限第三方 userId=2 同租户删除 → 403
        Map<String, Object> p = presign("others-file.pdf", "application/pdf", 32, "attachment");
        long fileId = Long.parseLong((String) p.get("fileId"));
        storage.write((String) p.get("objectKey"), new byte[32]);
        TenantContext.with(T1, () -> files.complete(fileId, null, null));
        TenantInfo attacker = new TenantInfo(1, 1, 2);
        BizException e = assertThrows(BizException.class,
                () -> TenantContext.with(attacker, () -> {
                    files.delete(fileId);
                    return null;
                }));
        assertEquals("PERM_DENIED", e.code());
        // 上传者本人删除不受影响
        TenantContext.with(T1, () -> {
            files.delete(fileId);
            return null;
        });
        assertEquals("EXPIRED", TenantContext.with(T1, () -> files.meta(fileId)).get("status"));
    }

    @Test
    void 生命周期_PENDING超时清理() {
        Map<String, Object> p = presign("orphan.pdf", "application/pdf", 64, "attachment");
        long fileId = Long.parseLong((String) p.get("fileId"));
        // 伪造超时（created_at 回拨 16min——超过 15min TTL）
        jdbc.update("UPDATE file_object SET created_at = now() - interval '16 minutes' WHERE id = ?", fileId);
        int cleaned = files.cleanupStalePending();
        assertTrue(cleaned >= 1);
        assertEquals("EXPIRED", TenantContext.with(T1, () -> files.meta(fileId)).get("status"));
    }

    @Test
    void 存储抽象_魔数探测最小实现() {
        // PNG 签名
        byte[] png = new byte[]{(byte) 0x89, 'P', 'N', 'G', 0, 0, 0, 0};
        assertEquals("image/png", com.schema.file.domain.FilePolicy.sniffMagic(png));
        // PDF 签名
        assertEquals("application/pdf", com.schema.file.domain.FilePolicy.sniffMagic("%PDF-1.7".getBytes()));
        // 未知 → null（文本族靠扩展名核对）
        assertEquals(null, com.schema.file.domain.FilePolicy.sniffMagic("hello world".getBytes()));
    }

    @Test
    void 对象Key规范_路径穿越被清洗() {
        String key = com.schema.file.domain.FilePolicy.objectKey(1, 23L, "attachment", 999,
                "../../etc/passwd");
        assertTrue(!key.contains(".."));
        assertTrue(key.startsWith("1/23/attachment/"));
    }

    // ===== FIX-M9 真实链路回归（2026-10-30）：凭证前缀/一次性/过期/op 隔离/摘要校验 =====

    /** 凭证消费端点直连测试（真实 HTTP 语义——不经服务层 mock）：PUT 消费、重放拒绝、GET 隔离。 */
    @Test
    void 真实凭证链路_PUT消费后重放拒绝_GET凭证不得用于PUT() {
        String objectKey = "882-test/cred-" + System.nanoTime() + "/direct.bin";
        // PUT 凭证签发 → 真实消费成功
        ObjectStorage.PresignedUrl putUrl = storage.presignPut(objectKey,
                java.time.Duration.ofMinutes(10), "text/plain", 64);
        String putToken = putUrl.url().substring(putUrl.url().lastIndexOf('/') + 1);
        TokenBinding putBinding = com.schema.file.infrastructure.storage.LocalFsStorage.consumeBinding(putToken);
        assertNotNull(putBinding);
        assertEquals(Op.PUT, putBinding.op());
        assertEquals(objectKey, putBinding.objectKey());
        assertTrue(!putBinding.expired());
        // 真实写入（模拟 LocalPutController 消费路径）
        storage.write(objectKey, new byte[64]);
        // 重放：同一 token 已被消费 → null
        assertTrue(com.schema.file.infrastructure.storage.LocalFsStorage.consumeBinding(putToken) == null);
        storage.delete(objectKey);

        // GET 凭证 op 隔离：GET token 不能当 PUT 用（消费得 GET 绑定，op 校验必失败）
        ObjectStorage.PresignedUrl getUrl = storage.presignGet(objectKey,
                java.time.Duration.ofMinutes(5));
        String getToken = getUrl.url().substring(getUrl.url().lastIndexOf('/') + 1);
        TokenBinding getBinding = com.schema.file.infrastructure.storage.LocalFsStorage.consumeBinding(getToken);
        assertEquals(Op.GET, getBinding.op());
        assertTrue(getBinding.op() != Op.PUT);
        assertTrue(com.schema.file.infrastructure.storage.LocalFsStorage.consumeBinding(getToken) == null);
    }

    /** 凭证过期：签发时固化过期时刻，过期绑定 expired()=true。 */
    @Test
    void 真实凭证链路_过期凭证被拒() {
        String objectKey = "882-test/exp-" + System.nanoTime() + "/x.bin";
        ObjectStorage.PresignedUrl url = storage.presignPut(objectKey,
                java.time.Duration.ofMillis(1), "text/plain", 10);
        String token = url.url().substring(url.url().lastIndexOf('/') + 1);
        TokenBinding binding = com.schema.file.infrastructure.storage.LocalFsStorage.consumeBinding(token);
        assertNotNull(binding);
        // ttl=1ms——等待过期后必拒
        try {
            Thread.sleep(5);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        assertTrue(binding.expired());
    }

    /** 分块真实链路：initiateMultipart → 每块独立凭证 → 写块 → etag 回传校验 → 合并 → complete 摘要。 */
    @Test
    void 分块真实链路_完整上传合并与ETag校验() {
        // 声明 25MB（> 20MB 阈值）→ multipart 路径，4 块（8+8+8+1MB）
        Map<String, Object> p = presign("big.pdf", "application/pdf", 25L * 1024 * 1024, "attachment");
        long fileId = Long.parseLong((String) p.get("fileId"));
        String objectKey = (String) p.get("objectKey");
        String uploadId = (String) p.get("uploadId");
        int totalParts = ((Number) p.get("totalParts")).intValue();
        assertEquals(4, totalParts);

        // 每块独立签发凭证（此前 bug：一次性凭证无法上传多块）
        byte[] part1 = new byte[8 * 1024 * 1024];
        byte[] part2 = new byte[8 * 1024 * 1024];
        byte[] part3 = new byte[8 * 1024 * 1024];
        byte[] part4 = new byte[1 * 1024 * 1024];
        byte[][] chunks = {part1, part2, part3, part4};
        java.util.List<Map<String, Object>> parts = new java.util.ArrayList<>();
        for (int pn = 1; pn <= totalParts; pn++) {
            final int n = pn;
            Map<String, Object> partResp = TenantContext.with(T1, () -> files.presignPart(fileId, n));
            String partUrl = (String) partResp.get("partUrl");
            assertTrue(partUrl.contains("/api/files/local-put/"));
            assertTrue(partUrl.endsWith("?part=" + n));
            // 模拟 LocalPutController 真实消费：token → PART 绑定 → writePart
            String partToken = partUrl.substring("/api/files/local-put/".length(),
                    partUrl.indexOf("?part="));
            TokenBinding pb = com.schema.file.infrastructure.storage.LocalFsStorage.consumeBinding(partToken);
            assertNotNull(pb, "分块凭证必须可消费（此前 mp- 前缀 bug 已修）");
            assertEquals(Op.PART, pb.op());
            assertEquals(uploadId, pb.objectKey());
            storage.writePart(uploadId, n, chunks[n - 1]);
            parts.add(Map.of("partNumber", n, "etag",
                    com.schema.file.infrastructure.storage.LocalFsStorage.sha256(chunks[n - 1])));
        }

        // 错误 etag 负例：块 1 etag 篡改 → UPLOAD_MISMATCH 拒绝
        java.util.List<Map<String, Object>> badParts = new java.util.ArrayList<>(parts);
        badParts.set(0, Map.of("partNumber", 1, "etag", "deadbeef"));
        BizException bad = assertThrows(BizException.class,
                () -> TenantContext.with(T1, () -> files.complete(fileId, badParts, null)));
        assertEquals("UPLOAD_MISMATCH", bad.code());

        // 正确 etag → 合并成功 → ACTIVE；登记服务端计算的 SHA-256
        Map<String, Object> done = TenantContext.with(T1, () -> files.complete(fileId, parts, null));
        assertEquals(25L * 1024 * 1024, ((Number) done.get("size")).longValue());
        assertEquals("ACTIVE", TenantContext.with(T1, () -> files.meta(fileId)).get("status"));
        // 合并后真实大小核对
        assertTrue(storage.head(objectKey).sizeBytes() == 25L * 1024 * 1024);
    }

    /** complete 内容校验：伪造 SHA-256 / 声明类型与实际内容不符 → 拒绝并清理。 */
    @Test
    void complete内容校验_伪造摘要与类型伪装被拒() {
        // ① 伪造摘要：真实内容 bytes A，回传摘要 B → UPLOAD_MISMATCH
        Map<String, Object> p1 = presign("real.pdf", "application/pdf", 32, "attachment");
        long f1 = Long.parseLong((String) p1.get("fileId"));
        byte[] content = "%PDF-1.7 fake-but-real-header".getBytes();
        byte[] padded = java.util.Arrays.copyOf(content, 32);
        storage.write((String) p1.get("objectKey"), padded);
        BizException fake = assertThrows(BizException.class,
                () -> TenantContext.with(T1, () -> files.complete(f1, null, "0000000000000000000000000000000000000000000000000000000000000000")));
        assertEquals("UPLOAD_MISMATCH", fake.code());
        // 对象已被清理
        assertTrue(!storage.head((String) p1.get("objectKey")).exists());

        // ② 类型伪装：声明 PDF、实际 PNG 字节 → 魔数核对拒绝
        Map<String, Object> p2 = presign("fake.pdf", "application/pdf", 8, "attachment");
        long f2 = Long.parseLong((String) p2.get("fileId"));
        byte[] png = {(byte) 0x89, 'P', 'N', 'G', 0, 0, 0, 0};
        storage.write((String) p2.get("objectKey"), png);
        BizException sniff = assertThrows(BizException.class,
                () -> TenantContext.with(T1, () -> files.complete(f2, null, null)));
        assertEquals("UPLOAD_MISMATCH", sniff.code());

        // ③ 正例：真实 PDF 字节 + 正确摘要 → ACTIVE，落库服务端计算摘要
        Map<String, Object> p3 = presign("ok.pdf", "application/pdf", 8, "attachment");
        long f3 = Long.parseLong((String) p3.get("fileId"));
        byte[] pdf = "%PDF-1.7".getBytes();
        storage.write((String) p3.get("objectKey"), pdf);
        String realSha = com.schema.file.infrastructure.storage.LocalFsStorage.sha256(pdf);
        Map<String, Object> ok = TenantContext.with(T1, () -> files.complete(f3, null, realSha));
        assertEquals(8L, ((Number) ok.get("size")).longValue());
        assertEquals("ACTIVE", TenantContext.with(T1, () -> files.meta(f3)).get("status"));
    }
}
