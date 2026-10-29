package com.schema.platform.common.web;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 业务错误（10BE §A.2）：{code:'BIZ_XXX', message, traceId, details?}；
 * HTTP 状态由接口层错误处理器按 code 映射。
 */
public class BizException extends RuntimeException {

    private final String code;
    private final Map<String, Object> details;

    public BizException(String code, String message) {
        this(code, message, null);
    }

    public BizException(String code, String message, Map<String, Object> details) {
        super(message);
        this.code = code;
        this.details = details != null ? details : Map.of();
    }

    public String code() {
        return code;
    }

    public Map<String, Object> details() {
        return details;
    }

    public Map<String, Object> body(String traceId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", code);
        body.put("message", getMessage());
        body.put("traceId", traceId);
        if (!details.isEmpty()) {
            body.put("details", details);
        }
        return body;
    }

    // 01BE §A.5 本域错误码工厂
    public static BizException versionConflict(int serverVersion) {
        return new BizException("MODEL_VERSION_CONFLICT", "Schema 版本冲突，请刷新后重试",
                Map.of("serverVersion", serverVersion));
    }

    public static BizException confirmTokenInvalid(String reason) {
        return new BizException("CONFIRM_TOKEN_INVALID", "确认令牌无效: " + reason);
    }

    public static BizException fieldKeyImmutable() {
        return new BizException("FIELD_KEY_IMMUTABLE", "字段标识与类型创建后不可修改");
    }

    public static BizException circularDependency(java.util.List<String> cycle) {
        return new BizException("CIRCULAR_DEPENDENCY", "计算字段依赖成环: " + String.join(" -> ", cycle));
    }

    public static BizException notFound(String what) {
        return new BizException("MODEL_NOT_FOUND", what + " 不存在");
    }

    /** 字段配置非法（01BE §4.2 步骤 4 校验器）。 */
    public static BizException fieldConfigInvalid(String reason) {
        return new BizException("FIELD_CONFIG_INVALID", "字段配置非法: " + reason);
    }

    /** relation.targetModelId 指向不存在/跨租户模型。 */
    public static BizException relationTargetNotFound(String targetModelId) {
        return new BizException("RELATION_TARGET_NOT_FOUND", "关系目标模型不存在: " + targetModelId);
    }

    // 03BE §A.4 IAM 域错误码工厂
    /** 登录失败统一文案（防账号枚举）。 */
    public static BizException unauthorized(String message) {
        return new BizException("UNAUTHORIZED", message);
    }

    /** 账号锁定（423 ACCOUNT_LOCKED，03BE §A.4）。 */
    public static BizException unauthorizedOrLocked(java.time.OffsetDateTime lockedUntil) {
        return new BizException("ACCOUNT_LOCKED", "账号已锁定，请稍后重试",
                lockedUntil == null ? Map.of() : Map.of("lockedUntil", lockedUntil.toString()));
    }

    /** 黑名单内 refresh（401 REFRESH_REVOKED——前端清快照跳登录）。 */
    public static BizException refreshRevoked() {
        return new BizException("REFRESH_REVOKED", "登录态已失效，请重新登录");
    }

    /** 请求头租户与 JWT claim 不一致（403 TENANT_MISMATCH，记安全审计）。 */
    public static BizException tenantMismatch() {
        return new BizException("TENANT_MISMATCH", "请求租户与登录租户不一致");
    }

    /** 建号/重置后未改密（403 PASSWORD_CHANGE_REQUIRED——仅放行改密/登出/me）。 */
    public static BizException passwordChangeRequired() {
        return new BizException("PASSWORD_CHANGE_REQUIRED", "首次登录需修改密码");
    }

    /** 功能权限不足（403 PERM_DENIED）。 */
    public static BizException permDenied() {
        return new BizException("PERM_DENIED", "权限不足");
    }

    // 04BE §A.6 页面域错误码工厂
    /** 路径租户内唯一性冲突（422 PATH_DUPLICATED）。 */
    public static BizException pathDuplicated() {
        return new BizException("PATH_DUPLICATED", "路由路径已存在");
    }

    /** 草稿 baseVersion 过期（409 DRAFT_VERSION_CONFLICT——三方对比流程）。 */
    public static BizException draftVersionConflict() {
        return new BizException("DRAFT_VERSION_CONFLICT", "草稿版本冲突，请刷新后重试");
    }

    /** 并发发布竞态（409 PUBLISH_CONFLICT）。 */
    public static BizException publishConflict() {
        return new BizException("PUBLISH_CONFLICT", "页面发布版本冲突，请重试");
    }

    /** 预览 grant 已使用/过期（401 GRANT_CONSUMED——不可重放）。 */
    public static BizException grantConsumed() {
        return new BizException("GRANT_CONSUMED", "预览凭证已使用或已过期");
    }

    /** 预览会话已被吊销（401 PREVIEW_SESSION_REVOKED——在途 token 即时失效）。 */
    public static BizException previewSessionRevoked() {
        return new BizException("PREVIEW_SESSION_REVOKED", "预览会话已被吊销");
    }

    /** 页面/发布版本不存在（404 PAGE_NOT_FOUND——04BE §A.6 域错误码与模型域分离）。 */
    public static BizException pageNotFound(String what) {
        return new BizException("PAGE_NOT_FOUND", what + " 不存在");
    }
}
