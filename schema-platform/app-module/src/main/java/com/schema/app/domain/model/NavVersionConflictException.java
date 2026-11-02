package com.schema.app.domain.model;

/**
 * 导航树乐观并发冲突（13BE §3.3）。
 *
 * <p>客户端提交导航树时必须携带 baseVersion；若服务端版本已推进（并发编辑），
 * 抛此异常 → HTTP 409 + 错误码 {@code NAV_VERSION_CONFLICT}，前端提示刷新。
 */
public class NavVersionConflictException extends RuntimeException {

    private final int baseVersion;
    private final int currentVersion;

    public NavVersionConflictException(int baseVersion, int currentVersion) {
        super("导航版本冲突：base=" + baseVersion + ", current=" + currentVersion);
        this.baseVersion = baseVersion;
        this.currentVersion = currentVersion;
    }

    public int baseVersion() { return baseVersion; }
    public int currentVersion() { return currentVersion; }
}