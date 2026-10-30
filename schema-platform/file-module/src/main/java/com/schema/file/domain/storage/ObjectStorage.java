package com.schema.file.domain.storage;

import java.time.Duration;
import java.util.List;

/**
 * 对象存储抽象（11BE §2 私有化红线：外部依赖接口化）。
 * 业务代码禁止出现 com.aliyun.* / io.minio.* 直接 import（CI 依赖扫描）。
 * 实现：LocalFsStorageImpl（本地开发零依赖）/ S3StorageImpl（MinIO/OSS 同协议，随部署接入）。
 */
public interface ObjectStorage {

    PresignedUrl presignPut(String objectKey, Duration expiry, String contentType, long maxSize);

    PresignedUrl presignGet(String objectKey, Duration expiry);

    /** 分块上传会话（> 20MB）。 */
    String initiateMultipart(String objectKey);

    PresignedUrl presignPartPut(String uploadId, int partNumber, Duration expiry);

    String completeMultipart(String uploadId, List<PartETag> parts);

    /** 分块内容落盘（multipart part 消费端点用）。 */
    void writePart(String uploadId, int partNumber, byte[] bytes);

    /** 分块按序合并到目标对象键（complete 消费端点用）。 */
    void mergeParts(String uploadId, List<Integer> partNumbers, String targetObjectKey);

    /** 分块内容 sha256（complete 时逐块核对客户端回传 etag；缺失返回 null）。 */
    default String partSha256(String uploadId, int partNumber) { return null; }

    void delete(String objectKey);

    /** HEAD 校验：对象存在性与真实大小（complete 时核对）。 */
    HeadInfo head(String objectKey);

    /** 读取对象字节（仅 LocalFs 实现支持；S3 场景走预签名不经过 Java）。 */
    byte[] read(String objectKey);

    void write(String objectKey, byte[] bytes);

    record PresignedUrl(String url, Duration expiry) {}

    record PartETag(int partNumber, String etag) {}

    record HeadInfo(boolean exists, long sizeBytes) {}
}
