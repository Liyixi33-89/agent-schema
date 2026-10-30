package com.schema.platform.common.tenant;

/**
 * 预览态请求上下文（04BE §A.7 数据面收口）：
 * JwtAuthFilter 以请求属性传递（auth.preview / auth.previewPageId /
 * auth.previewAllowRealWrite），Controller 层在进入引擎前绑定到 ThreadLocal——
 * 引擎与守卫消费后必须 finally 清理（与 TenantContext 同生命周期纪律）。
 *
 * 拆分后随 RPC 上下文头传递（x-preview: 1 / x-preview-page / x-preview-write）。
 */
public final class PreviewContext {

    private static final ThreadLocal<State> STATE = new ThreadLocal<>();

    private PreviewContext() {
    }

    /** 预览态绑定值：preview=false 时其余字段无意义。appId=null 表示会话应用未知（不校验应用范围）。 */
    public static void bind(boolean preview, Long appId, Long pageId, Boolean allowRealWrite) {
        STATE.set(new State(preview, appId, pageId, allowRealWrite));
    }

    /** 兼容旧签名（无应用上下文）。 */
    public static void bind(boolean preview, Long pageId, Boolean allowRealWrite) {
        bind(preview, null, pageId, allowRealWrite);
    }

    public static boolean isPreview() {
        State s = STATE.get();
        return s != null && s.preview;
    }

    public static Long appId() {
        State s = STATE.get();
        return s == null ? null : s.appId;
    }

    public static Long pageId() {
        State s = STATE.get();
        return s == null ? null : s.pageId;
    }

    /** allowRealWrite 只在预览态有意义；非预览态恒 true（正常登录态无只读限制）。 */
    public static boolean allowRealWrite() {
        State s = STATE.get();
        if (s == null || !s.preview) {
            return true;
        }
        return Boolean.TRUE.equals(s.allowRealWrite);
    }

    public static void clear() {
        STATE.remove();
    }

    private record State(boolean preview, Long appId, Long pageId, Boolean allowRealWrite) {
    }
}
