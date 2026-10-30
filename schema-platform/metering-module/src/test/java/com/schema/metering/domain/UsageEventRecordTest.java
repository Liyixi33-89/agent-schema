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
        Map<String, Object> env = env("funnel.ai.invoke");
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
        // 09FE §2 前端事件 type → 后端漏斗指标映射：ai.invoke → funnel.ai.invoke（发起计数漏斗）
        assertNull(UsageEventRecord.validateEnvelope(0, env("funnel.ai.invoke")));
        // artifact.load → funnel.artifact.load（编译执行次数 build.count 由服务端埋点终审）
        assertNull(UsageEventRecord.validateEnvelope(0, env("funnel.artifact.load")));
        // automation.trigger 不在口径集（真正执行次数服务端埋 flow.exec）——前端事件被拒属预期
        assertNotNull(UsageEventRecord.validateEnvelope(0, env("automation.trigger")));
        // 终审指标禁走客户端通道（09BE §4 计费一律服务端埋点）
        assertNotNull(UsageEventRecord.validateEnvelope(0, env("build.count")));
        assertNotNull(UsageEventRecord.validateEnvelope(0, env("ai.tokens.in")));
    }

    @Test
    void 防伪造_source由通道强制客户端声明不作数() {
        Map<String, Object> env = env("seat.active");
        env.put("source", "SERVER");
        UsageEventRecord r = UsageEventRecord.normalize(0, 1L, 1L, env, OffsetDateTime.now(), "CLIENT");
        assertEquals("CLIENT", r.source());
    }

    @Test
    void 时间归属_未来occurredAt按receivedAt归属() {
        Map<String, Object> env = env("seat.active");
        env.put("occurredAt", OffsetDateTime.now().plusHours(3).toString());
        OffsetDateTime receivedAt = OffsetDateTime.now();
        UsageEventRecord r = UsageEventRecord.normalize(0, 1L, 1L, env, receivedAt, "CLIENT");
        assertEquals(receivedAt, r.occurredAt());
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
        UsageEventRecord r = UsageEventRecord.normalize(0, 1L, 1L, env, receivedAt, "CLIENT");
        assertEquals(receivedAt, r.occurredAt());
    }

    @Test
    void 时间归属_24h内保留客户端时间() {
        Map<String, Object> env = env("seat.active");
        OffsetDateTime occurred = OffsetDateTime.now().minusHours(23);
        env.put("occurredAt", occurred.toString());
        UsageEventRecord r = UsageEventRecord.normalize(0, 1L, 1L, env, OffsetDateTime.now(), "CLIENT");
        assertEquals(occurred, r.occurredAt());
    }

    @Test
    void quantity缺省为1且非正数被拒() {
        Map<String, Object> env = env("seat.active");
        env.put("quantity", 0);
        assertNotNull(UsageEventRecord.validateEnvelope(0, env));

        Map<String, Object> ok = env("seat.active");
        UsageEventRecord r = UsageEventRecord.normalize(0, 1L, 1L, ok, OffsetDateTime.now(), "CLIENT");
        assertEquals(1L, r.quantity());
    }

    @Test
    void 服务端终审指标集与全口径集一致校验() {
        // 计费口径七指标必须在服务端终审集；漏斗指标必须在客户端通道白名单
        List<String> billing = List.of("seat.active", "flow.exec", "api.calls", "storage.gb",
                "build.count", "ai.tokens.in", "ai.tokens.out");
        assertTrue(MeteringPolicy.SERVER_FINAL_METRICS.containsAll(billing));
        assertTrue(MeteringPolicy.METRICS.containsAll(MeteringPolicy.SERVER_FINAL_METRICS));
        List<String> funnel = List.of("funnel.ai.invoke", "funnel.artifact.load");
        assertTrue(MeteringPolicy.CLIENT_CHANNEL_METRICS.containsAll(funnel));
        // 终审指标与客户端通道交集只允许 seat.active（漏斗参考允许，聚合只信服务端行）
        for (String m : MeteringPolicy.SERVER_FINAL_METRICS) {
            if (!"seat.active".equals(m)) {
                assertTrue(!MeteringPolicy.CLIENT_CHANNEL_METRICS.contains(m),
                        m + " 不得进客户端通道白名单");
            }
        }
    }
}
