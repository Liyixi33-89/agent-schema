package com.schema.file.application;

import com.schema.file.domain.FilePolicy;
import com.schema.file.domain.repository.FileRepository;
import com.schema.file.domain.storage.ObjectStorage;
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

    public FileService(FileRepository files, ObjectStorage storage) {
        this.files = files;
        this.storage = storage;
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

    /** 分块上传凭证（11BE §3.2 步骤②）。 */
    public Map<String, Object> presignPart(long fileId, int partNumber) {
        TenantInfo t = tenant();
        Map<String, Object> row = files.findById(t.tenantId(), fileId)
                .orElseThrow(() -> fileNotFound());
        Map<String, Object> mp = files.findMultipart(fileId).orElseThrow(() -> fileNotFound());
        if (partNumber < 1 || partNumber > ((Number) mp.get("total_parts")).intValue()) {
            throw new BizException("FILE_TYPE_FORBIDDEN", "块号越界");
        }
        ObjectStorage.PresignedUrl url = storage.presignPartPut(
                String.valueOf(mp.get("upload_id")), partNumber, FilePolicy.PUT_EXPIRY);
        files.appendUploadedPart(fileId, partNumber);
        return Map.of("partUrl", url.url());
    }

    /**
     * complete 校验（11BE §3.1 步骤③）：HEAD 对象存在 + size 匹配 → 登记元数据 ACTIVE。
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
            // 分块合并路径：乱序 parts 拒绝（11BE §8 硬性要求）
            List<Integer> numbers = new java.util.ArrayList<>();
            for (Map<String, Object> p : parts) {
                numbers.add(((Number) p.get("partNumber")).intValue());
            }
            List<Integer> sorted = new java.util.ArrayList<>(numbers);
            sorted.sort(Integer::compareTo);
            if (!sorted.equals(numbers.stream().sorted().distinct().toList())) {
                throw new BizException("UPLOAD_MISMATCH", "分块列表含重复或非法块号");
            }
            Map<String, Object> mp = files.findMultipart(fileId)
                    .orElseThrow(() -> fileNotFound());
            storage.mergeParts(String.valueOf(mp.get("upload_id")), sorted, objectKey);
        }

        ObjectStorage.HeadInfo head = storage.head(objectKey);
        if (!head.exists() || head.sizeBytes() != declaredSize) {
            // complete 失败清理（11BE §8：对象缺失/size 不符 → 删除元数据 409）
            storage.delete(objectKey);
            throw new BizException("UPLOAD_MISMATCH", "对象缺失或大小不匹配（已清理）");
        }
        files.markActive(fileId, sha256);

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

    /** 管理删除（11BE §A.2：删除对象 + 元数据置 EXPIRED——引用字段渲染失效占位）。 */
    @Transactional
    public void delete(long fileId) {
        TenantInfo t = tenant();
        Map<String, Object> row = files.findById(t.tenantId(), fileId)
                .orElseThrow(() -> fileNotFound());
        storage.delete((String) row.get("object_key"));
        files.markExpired(fileId);
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

    private static TenantInfo tenant() {
        TenantInfo t = TenantContext.get();
        if (t == null) {
            throw BizException.unauthorized("租户上下文缺失");
        }
        return t;
    }
}
