package com.schema.metering.domain;

import java.util.Set;

/**
 * 计量域常量与合规白名单（09BE §1/§8）。
 * 红线：payload 只允许 ID/枚举/数值，禁止任何业务字段值。
 */
public final class MeteringPolicy {

    private MeteringPolicy() {}

    /** 指标口径（09BE §4 表）+ 前端漏斗专用指标（不入计费口径——09FE 前端事件仅漏斗）。 */
    public static final Set<String> METRICS = Set.of(
            "seat.active", "flow.exec", "ai.tokens.in", "ai.tokens.out",
            "api.calls", "storage.gb", "build.count",
            "funnel.ai.invoke", "funnel.artifact.load");

    /** 服务端终审指标（前端事件仅漏斗；计费口径一律服务端埋点）。
     *  ai.tokens.in/out 一并纳入终审集：token 消耗以 AI 网关服务端为准（09BE §4），
     *  前端 ai.invoke 发起计数走 funnel.ai.invoke 漏斗指标，不得冒充 token 计量。 */
    public static final Set<String> SERVER_FINAL_METRICS = Set.of(
            "seat.active", "flow.exec", "api.calls", "storage.gb", "build.count",
            "ai.tokens.in", "ai.tokens.out");

    /** 客户端通道准入指标（HTTP 上报白名单）：漏斗专用 + seat.active 漏斗参考。
     *  终审指标（含 ai.tokens）禁走客户端通道——聚合只消费服务端行，前端伪造无从生效。 */
    public static final Set<String> CLIENT_CHANNEL_METRICS = Set.of(
            "seat.active", "funnel.ai.invoke", "funnel.artifact.load");

    /** attrs 白名单键（每 metric 独立；越键即违规）。 */
    public static final Set<String> ATTR_KEYS = Set.of(
            "surface", "feature", "flowId", "trigger", "pageId", "hash", "appId");

    /** 字符串值长度上限（防借合法键塞业务值）。 */
    public static final int MAX_STRING_LEN = 64;

    /** 时间归属回溯窗口（小时）——超出按 received_at 落日（防跨月逃配额）。 */
    public static final int OCCURRED_BACKTRACK_HOURS = 24;

    /** 批量上报上限（09BE §A.1）。 */
    public static final int MAX_BATCH = 100;
}
