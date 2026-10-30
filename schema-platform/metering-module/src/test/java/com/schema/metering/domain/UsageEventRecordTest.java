package com.schema.metering.domain;

import org.junit.jupiter.api.Test;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 09BE §9 单测硬性要求：合规白名单 / 时间归属 / 幂等键校验。
 */
class UsageEventRecordTest {

    private static Map<String, Object> env(String metric) {
        Map<String, Object> env = new LinkedHashMap<>();
        env.put("eventId", UUID.randomUUID().toString());
        env.put("metric", metric);
        env.put("occurredAt", OffsetDateTime.now().toString());
        return env;
    }

    @Test
    void 合规扫描_业务字段值被拒() {
        // 业务字段值（表单值）塞进 attrs → 违规
        Map<String, Object> env = env("seat.active");
        env.put("attrs", Map.of("formValue", "客户手机号 13800138000"));
        String reason = UsageEventRecord.validateEnvelope(0, env);
        assertNotNull(reason);
        assertTrue(reason.contains("非白名单键"));
    }

    @Test
    void 合规扫描_嵌套对象值被拒() {
        Map<String, Object> env = env("ai.tokens.in");
        env.put("attrs", Map.of("feature", Map.of("nested", "业务对象")));
        String reason = UsageEventRecord.validateEnvelope(0, env);
        assertNotNull(reason);
        assertTrue(reason.contains("标量"));
    }

    @Test
    void 合规扫描_白名单值正常通过() {
        Map<String, Object> env = env("seat.active");
        env.put("attrs", Map.of("surface", "designer", "pageId", 42));
        assertNull(UsageEventRecord.validateEnvelope(0, env));
    }

    @Test
    void 合规扫描_超长字符串被拒() {
        Map<String, Object> env = env("automation.trigger");
        env.put("attrs", Map.of("trigger", "x".repeat(65)));
        assertNotNull(UsageEventRecord.validateEnvelope(0, env));
    }

    @Test
    void 口径边界_前端漏斗事件类型映射() {
        // 09FE §2 前端事件 type → 后端 metric 映射：ai.invoke 上报侧归并到 ai.tokens.in 漏斗口径
        // automation.trigger 不在计费口径集（真正执行次数服务端埋 flow.exec）——前端事件被拒属预期
        assertNotNull(UsageEventRecord.validateEnvelope(0, env("automation.trigger")));
    }

    @Test
    void 幂等键_eventId_非UUID被拒() {
        Map<String, Object> env = env("seat.active");
        env.put("eventId", "not-a-uuid");
        assertNotNull(UsageEventRecord.validateEnvelope(0, env));
    }

    @Test
    void 口径白名单_未知metric被拒() {
        assertNotNull(UsageEventRecord.validateEnvelope(0, env("fake.metric")));
    }

    @Test
    void 时间归属_超24h回溯按receivedAt落日() {
        Map<String, Object> env = env("seat.active");
        env.put("occurredAt", OffsetDateTime.now().minusHours(25).toString());
        OffsetDateTime receivedAt = OffsetDateTime.now();
        UsageEventRecord r = UsageEventRecord.normalize(0, 1L, 1L, env, receivedAt);
        assertEquals(receivedAt, r.occurredAt());
    }

    @Test
    void 时间归属_24h内保留客户端时间() {
        Map<String, Object> env = env("seat.active");
        OffsetDateTime occurred = OffsetDateTime.now().minusHours(23);
        env.put("occurredAt", occurred.toString());
        UsageEventRecord r = UsageEventRecord.normalize(0, 1L, 1L, env, OffsetDateTime.now());
        assertEquals(occurred, r.occurredAt());
    }

    @Test
    void quantity缺省为1且非正数被拒() {
        Map<String, Object> env = env("flow.exec");
        env.put("quantity", 0);
        assertNotNull(UsageEventRecord.validateEnvelope(0, env));

        Map<String, Object> ok = env("flow.exec");
        UsageEventRecord r = UsageEventRecord.normalize(0, 1L, 1L, ok, OffsetDateTime.now());
        assertEquals(1L, r.quantity());
    }

    @Test
    void 服务端终审指标集与全口径集一致校验() {
        // seat.active / flow.exec / api.calls / storage.gb / build.count 必须在服务端终审集
        List<String> billing = List.of("seat.active", "flow.exec", "api.calls", "storage.gb", "build.count");
        assertTrue(MeteringPolicy.SERVER_FINAL_METRICS.containsAll(billing));
        assertTrue(MeteringPolicy.METRICS.containsAll(MeteringPolicy.SERVER_FINAL_METRICS));
    }
}
