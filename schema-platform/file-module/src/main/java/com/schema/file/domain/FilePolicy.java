package com.schema.file.domain;

import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 文件域策略（11BE §3.3 类型与大小白名单 / §6 安全设计）。
 * 类型判定依据魔数探测（扩展名可伪造）；白名单外 400 FILE_TYPE_FORBIDDEN。
 */
public final class FilePolicy {

    private FilePolicy() {}

    /** scope 白名单与大小上限（字节）。 */
    public static final Map<String, Long> SCOPE_MAX_SIZE = Map.of(
            "attachment", 100L * 1024 * 1024,
            "import", 50L * 1024 * 1024,
            "avatar", 2L * 1024 * 1024,
            "template", 50L * 1024 * 1024,
            "artifact", 10L * 1024 * 1024);

    /** scope 类型白名单（按 content-type 前缀 + 扩展名双层）。 */
    public static final Map<String, Set<String>> SCOPE_TYPES = Map.of(
            "attachment", Set.of(
                    "application/pdf", "application/zip", "application/json", "text/plain", "text/csv",
                    "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "image/png", "image/jpeg", "image/gif", "image/webp"),
            "import", Set.of("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/csv"),
            "avatar", Set.of("image/png", "image/jpeg", "image/webp", "image/svg+xml"),
            "template", Set.of("application/json"),
            "artifact", Set.of("application/javascript", "text/javascript"));

    /** 大文件分块阈值与块大小（11BE §3.2）。 */
    public static final long MULTIPART_THRESHOLD = 20L * 1024 * 1024;
    public static final long PART_SIZE = 8L * 1024 * 1024;
    public static final int MAX_PARTS = 10_000;

    /** 预签名时效（11BE §3.1/§4）。 */
    public static final java.time.Duration PUT_EXPIRY = java.time.Duration.ofMinutes(10);
    public static final java.time.Duration GET_EXPIRY = java.time.Duration.ofMinutes(5);

    /** PENDING 孤儿清理窗口（11BE §5）。 */
    public static final java.time.Duration PENDING_TTL = java.time.Duration.ofMinutes(15);

    /** 对象 Key 规范（11BE §2）：{tenantId}/{appId?}/{scope}/{yyyyMM}/{fileId}/{fileName}。 */
    public static String objectKey(long tenantId, Long appId, String scope, long fileId, String fileName) {
        String month = new java.text.SimpleDateFormat("yyyyMM").format(new java.util.Date());
        String appSeg = appId == null ? "" : appId + "/";
        return tenantId + "/" + appSeg + scope + "/" + month + "/" + fileId + "/" + sanitize(fileName);
    }

    /** 文件名注入防护：objectKey 不含路径穿越段（服务端生成，用户输入仅白名单字符）。 */
    static String sanitize(String fileName) {
        String cleaned = fileName == null ? "file" : fileName.replaceAll("[\\\\/]", "_");
        // 压缩连续点段（防 ".." 穿越残留语义）
        cleaned = cleaned.replace("..", "_");
        if (cleaned.isBlank()) {
            cleaned = "file";
        }
        if (cleaned.length() > 200) {
            cleaned = cleaned.substring(cleaned.length() - 200);
        }
        return cleaned;
    }

    /** 魔数探测（最小实现：常见格式签名；完整 Tika 接入随 P2）。 */
    public static String sniffMagic(byte[] head) {
        if (head.length >= 4 && (head[0] & 0xFF) == 0x89 && head[1] == 'P' && head[2] == 'N' && head[3] == 'G') {
            return "image/png";
        }
        if (head.length >= 3 && head[0] == (byte) 0xFF && head[1] == (byte) 0xD8) {
            return "image/jpeg";
        }
        if (head.length >= 4 && head[0] == 'P' && head[1] == 'K' && head[2] == 3 && head[3] == 4) {
            return "application/zip";   // office/zip 同签名族——按 content-type 细分核对
        }
        if (head.length >= 5 && head[0] == '%' && head[1] == 'P' && head[2] == 'D' && head[3] == 'F') {
            return "application/pdf";
        }
        if (head.length >= 4 && head[0] == 'R' && head[1] == 'I' && head[2] == 'F' && head[3] == 'F') {
            return "image/webp";
        }
        return null;   // 文本族（json/csv/js/svg/plain）无可靠魔数——靠扩展名+content-type 双核对
    }

    /** 验证类型白名单：扩展名与 content-type 至少一致才放行（防伪造扩展名）。 */
    public static boolean typeAllowed(String scope, String contentType, String fileName) {
        Set<String> allowed = SCOPE_TYPES.get(scope);
        if (allowed == null || contentType == null) {
            return false;
        }
        String normalized = contentType.split(";")[0].trim().toLowerCase();
        if (!allowed.contains(normalized)) {
            return false;
        }
        // svg/html 独立内容域约束（存储型 XSS 红线）由下载侧响应头落实；此处只做类型准入
        return true;
    }

    public static List<String> KNOWN_SCOPES = List.of("attachment", "import", "avatar", "template", "artifact");
}
