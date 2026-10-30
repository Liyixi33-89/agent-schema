package com.schema.bootstrap;

import com.schema.file.application.FileService;
import com.schema.file.infrastructure.storage.LocalFsStorage;
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

    @Autowired
    private FileService files;

    @Autowired
    private LocalFsStorage storage;

    @Autowired
    private JdbcTemplate jdbc;

    private long lastFileId;

    @BeforeAll
    void setup() {
        jdbc.update("INSERT INTO sys_user (tenant_id, account, status) VALUES (1, 'it_file_user', 'ACTIVE') ON CONFLICT DO NOTHING");
    }

    @AfterAll
    void cleanup() {
        jdbc.update("DELETE FROM file_object WHERE tenant_id IN (1, 882)");
        jdbc.update("DELETE FROM file_multipart_session WHERE file_id NOT IN (SELECT id FROM file_object)");
        jdbc.update("DELETE FROM sys_user WHERE tenant_id = 1 AND account = 'it_file_user'");
    }

    private Map<String, Object> presign(String name, String type, long size, String scope) {
        return TenantContext.with(T1, () -> files.presign(name, type, size, scope, null));
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
        storage.write((String) p.get("objectKey"), new byte[512]);
        Map<String, Object> done = TenantContext.with(T1, () -> files.complete(fileId, null, "deadbeef"));
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
}
