package com.schema.file.application;

import com.schema.file.domain.FilePolicy;
import com.schema.file.domain.repository.FileRepository;
import com.schema.file.domain.storage.ObjectStorage;
import com.schema.file.infrastructure.storage.LocalFsStorage;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 文件服务（11BE §3 上传协议 / §4 元数据 / §6 安全设计）。
 * 核心决策：浏览器直传对象存储，本服务只签凭证 + 记元数据（字节流不过 Java）。
 */
@Service
public class FileService {

    private final FileRepository files;
    private final ObjectStorage storage;
    private final com.schema.iam.domain.repository.IamRepository iam;

    public FileService(FileRepository files, ObjectStorage storage,
            @org.springframework.beans.factory.annotation.Autowired(required = false)
            com.schema.iam.domain.repository.IamRepository iam) {
        this.files = files;
        this.storage = storage;
        this.iam = iam;
    }

    /**
     * 上传凭证签发（11BE §3.1 步骤①）：类型白名单 + 大小上限 + 配额预检。
     * 大文件（> 20MB）自动转分块会话（§3.2）。
     */
    @Transactional
    public Map<String, Object> presign(String fileName, String contentType, long size, String scope, Long appId) {
        validateScope(scope, contentType, size);
        TenantInfo t = TenantContext.get();
        long fileId = files.insertPending(t.tenantId(), appId, scope, fileName, contentType, size,
                t.operatorId());
        String objectKey = FilePolicy.objectKey(t.tenantId(), appId, scope, fileId, fileName);
        files.updateObjectKey(fileId, objectKey);

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("fileId", Long.toString(fileId));
        if (size > FilePolicy.MULTIPART_THRESHOLD) {
            // 分块路径（11BE §3.2）：块大小 8MB，1-10000 块
            int totalParts = (int) Math.ceil((double) size / FilePolicy.PART_SIZE);
            if (totalParts > FilePolicy.MAX_PARTS) {
                throw new BizException("FILE_TOO_LARGE", "文件超出分块上传上限");
            }
            String uploadId = storage.initiateMultipart(objectKey);
            files.saveMultipart(fileId, uploadId, FilePolicy.PART_SIZE, totalParts);
            resp.put("uploadId", uploadId);
            resp.put("partSize", FilePolicy.PART_SIZE);
            resp.put("totalParts", totalParts);
        } else {
            ObjectStorage.PresignedUrl url = storage.presignPut(objectKey, FilePolicy.PUT_EXPIRY,
                    contentType, size);
            resp.put("uploadUrl", url.url());
        }
        resp.put("objectKey", objectKey);
        return resp;
    }

    /** 分块上传凭证（11BE §3.2 步骤②）。凭证签发不代表块已上传——实际传块由客户端 PUT 决定。 */
    public Map<String, Object> presignPart(long fileId, int partNumber) {
        TenantInfo t = tenant();
        files.findById(t.tenantId(), fileId)
                .orElseThrow(() -> fileNotFound());
        Map<String, Object> mp = files.findMultipart(fileId).orElseThrow(() -> fileNotFound());
        if (partNumber < 1 || partNumber > ((Number) mp.get("total_parts")).intValue()) {
            throw new BizException("FILE_TYPE_FORBIDDEN", "块号越界");
        }
        ObjectStorage.PresignedUrl url = storage.presignPartPut(
                String.valueOf(mp.get("upload_id")), partNumber, FilePolicy.PUT_EXPIRY);
        return Map.of("partUrl", url.url());
    }

    /**
     * complete 校验（11BE §3.1 步骤③）：HEAD 对象存在 + size 匹配 → 登记元数据 ACTIVE。
     * 分块路径额外校验：parts 序列完整覆盖 1..totalParts（缺块/重复/乱序拒绝）。
     * 不匹配删除元数据返回 409 UPLOAD_MISMATCH。
     */
    @Transactional
    public Map<String, Object> complete(long fileId, List<Map<String, Object>> parts, String sha256) {
        TenantInfo t = tenant();
        Map<String, Object> row = files.findById(t.tenantId(), fileId)
                .orElseThrow(() -> fileNotFound());
        String objectKey = (String) row.get("object_key");
        long declaredSize = ((Number) row.get("size_bytes")).longValue();

        if (parts != null && !parts.isEmpty()) {
            // 分块合并路径（11BE §8 硬性要求）：块号必须完整覆盖 1..totalParts 且不重复
            List<Integer> numbers = new java.util.ArrayList<>();
            for (Map<String, Object> p : parts) {
                Object pn = p == null ? null : p.get("partNumber");
                if (!(pn instanceof Number)) {
                    throw new BizException("UPLOAD_MISMATCH", "分块列表含非法块号");
                }
                numbers.add(((Number) pn).intValue());
            }
            Map<String, Object> mp = files.findMultipart(fileId)
                    .orElseThrow(() -> fileNotFound());
            int totalParts = ((Number) mp.get("total_parts")).intValue();
            List<Integer> expected = new java.util.ArrayList<>();
            for (int i = 1; i <= totalParts; i++) {
                expected.add(i);
            }
            List<Integer> sorted = new java.util.ArrayList<>(numbers);
            sorted.sort(Integer::compareTo);
            if (!sorted.equals(expected)) {
                throw new BizException("UPLOAD_MISMATCH", "分块列表不完整或含重复块号（需 1.." + totalParts + "）");
            }
            String uploadId = String.valueOf(mp.get("upload_id"));
            // 分块 ETag 校验（2026-10-30 FIX-M9）：客户端回传每块 etag 必须与服务端落盘内容 sha256 一致
            for (Map<String, Object> p : parts) {
                Object etag = p == null ? null : p.get("etag");
                int n = ((Number) p.get("partNumber")).intValue();
                if (!(etag instanceof String s) || s.isBlank()) {
                    throw new BizException("UPLOAD_MISMATCH", "分块 " + n + " 缺少 etag");
                }
                String actual = storage.partSha256(uploadId, n);
                if (actual == null || !actual.equalsIgnoreCase(((String) etag).trim())) {
                    throw new BizException("UPLOAD_MISMATCH", "分块 " + n + " etag 不匹配");
                }
            }
            storage.mergeParts(uploadId, sorted, objectKey);
            try {
                LocalFsStorage.releaseSession(uploadId);
            } catch (NoClassDefFoundError | Exception ignored) {
                // 非 LocalFs 部署（S3）无内存会话可清理——忽略
            }
        }

        ObjectStorage.HeadInfo head = storage.head(objectKey);
        if (!head.exists() || head.sizeBytes() != declaredSize) {
            // complete 失败清理（11BE §8：对象缺失/size 不符 → 删除元数据 409）
            storage.delete(objectKey);
            throw new BizException("UPLOAD_MISMATCH", "对象缺失或大小不匹配（已清理）");
        }

        // 真实内容校验（2026-10-30 FIX-M9——同大小伪造内容不得登记 ACTIVE）：
        // ① 服务端读取对象字节计算 SHA-256，与客户端回传摘要比对（客户端不传则落库服务端计算值）；
        // ② 魔数探测识别实际类型，与声明 content-type 家族核对（文本族无魔数——跳过）。
        byte[] content = storage.read(objectKey);
        String actualSha = LocalFsStorage.sha256(content);
        if (sha256 != null && !sha256.isBlank()) {
            if (!actualSha.equalsIgnoreCase(sha256.trim())) {
                storage.delete(objectKey);
                throw new BizException("UPLOAD_MISMATCH", "SHA-256 摘要不匹配（已清理）");
            }
        }
        String declaredType = String.valueOf(row.get("content_type"));
        String sniffed = FilePolicy.sniffMagic(java.util.Arrays.copyOf(content,
                Math.min(content.length, 16)));
        if (sniffed != null && !sniffMatches(sniffed, declaredType)) {
            storage.delete(objectKey);
            throw new BizException("UPLOAD_MISMATCH", "实际内容类型与声明不符（已清理）");
        }
        files.markActive(fileId, actualSha);

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("fileId", Long.toString(fileId));
        resp.put("fileName", row.get("file_name"));
        resp.put("size", declaredSize);
        return resp;
    }

    /** 下载凭证签发（11BE §4：同租户校验——IDOR 纪律每次签发逐条校验归属）。 */
    public Map<String, Object> downloadUrl(long fileId) {
        TenantInfo t = tenant();
        Map<String, Object> row = files.findById(t.tenantId(), fileId)
                .orElseThrow(() -> fileNotFound());
        String status = String.valueOf(row.get("status"));
        if (!"ACTIVE".equals(status)) {
            throw new BizException("FILE_EXPIRED", "文件已失效");
        }
        ObjectStorage.PresignedUrl url = storage.presignGet(
                (String) row.get("object_key"), FilePolicy.GET_EXPIRY);
        return Map.of("downloadUrl", url.url());
    }

    /** 元数据查询（11BE §A.2：无内容流）。 */
    public Map<String, Object> meta(long fileId) {
        TenantInfo t = tenant();
        Map<String, Object> row = files.findById(t.tenantId(), fileId)
                .orElseThrow(() -> fileNotFound());
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("fileId", Long.toString(fileId));
        resp.put("fileName", row.get("file_name"));
        resp.put("contentType", row.get("content_type"));
        resp.put("size", ((Number) row.get("size_bytes")).longValue());
        resp.put("status", String.valueOf(row.get("status")));
        return resp;
    }

    /** 管理删除（11BE §A.2）：上传者本人或持 org:manage 权限可删；删除对象 + 元数据置 EXPIRED。 */
    @Transactional
    public void delete(long fileId) {
        TenantInfo t = tenant();
        Map<String, Object> row = files.findById(t.tenantId(), fileId)
                .orElseThrow(() -> fileNotFound());
        assertDeleteAllowed(t, row);
        storage.delete((String) row.get("object_key"));
        files.markExpired(fileId);
    }

    /** 删除授权（对象归属）：上传者本人 ∪ 组织管理权限点（03BE §A.3）。 */
    private void assertDeleteAllowed(TenantInfo t, Map<String, Object> row) {
        Long uploadedBy = row.get("uploaded_by") == null ? null : ((Number) row.get("uploaded_by")).longValue();
        if (uploadedBy != null && uploadedBy == t.operatorId()) {
            return;
        }
        if (t.operatorId() > 0 && iam != null) {
            List<Map<String, Object>> roles = iam.findRolesOfUser(t.tenantId(), t.operatorId());
            List<Long> roleIds = roles.stream().map(r -> ((Number) r.get("id")).longValue()).toList();
            boolean manage = iam.findPermsOfRoles(roleIds).stream()
                    .anyMatch(p -> "action:org:manage".equals(p.toPermString()));
            if (manage) {
                return;
            }
        }
        throw BizException.permDenied();
    }

    /** 生命周期：PENDING 孤儿清理（11BE §5——幂等：删除对象 + 置 EXPIRED 双写）。 */
    @Transactional
    public int cleanupStalePending() {
        OffsetDateTime before = OffsetDateTime.now().minus(FilePolicy.PENDING_TTL);
        List<Map<String, Object>> stale = files.findStalePending(before, 500);
        for (Map<String, Object> row : stale) {
            try {
                storage.delete((String) row.get("object_key"));
            } catch (Exception ignored) {
                // 对象缺失幂等——元数据仍置 EXPIRED
            }
            files.markExpired(((Number) row.get("id")).longValue());
        }
        return stale.size();
    }

    private void validateScope(String scope, String contentType, long size) {
        Long max = FilePolicy.SCOPE_MAX_SIZE.get(scope);
        if (max == null) {
            throw new BizException("FILE_TYPE_FORBIDDEN", "非法 scope: " + scope);
        }
        if (size > max) {
            throw new BizException("FILE_TOO_LARGE", "超过 " + scope + " 上限 " + (max / 1024 / 1024) + "MB");
        }
        if (!FilePolicy.typeAllowed(scope, contentType, null)) {
            throw new BizException("FILE_TYPE_FORBIDDEN", "类型不在 " + scope + " 白名单");
        }
    }

    private static BizException fileNotFound() {
        return new BizException("FILE_NOT_FOUND", "文件不存在");
    }

    /** 魔数识别类型与声明类型的家族核对：zip 族（zip/docx/xlsx）与 riff 族按 content-type 前缀细分。 */
    private static boolean sniffMatches(String sniffed, String declared) {
        if (declared == null) {
            return false;
        }
        String d = declared.split(";")[0].trim().toLowerCase();
        if (sniffed.equals(d)) {
            return true;
        }
        return switch (sniffed) {
            // PK 签名族——zip 及 office openxml 包装同源
            case "application/zip" -> d.endsWith("zip")
                    || d.contains("officedocument")
                    || d.equals("application/msword")
                    || d.equals("application/vnd.ms-excel");
            default -> false;
        };
    }

    private static TenantInfo tenant() {
        TenantInfo t = TenantContext.get();
        if (t == null) {
            throw BizException.unauthorized("租户上下文缺失");
        }
        return t;
    }
}
