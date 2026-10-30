package com.schema.data.infrastructure.outbox;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;

/**
 * Outbox 可靠事件链路（M2 尾项收口 2026-10-30；二轮补租约恢复）：
 * 业务事务内写 outbox 表（同事务原子性）→ 轮询投递（至少一次）→ 消费成功标记 DONE。
 * MVP 消费方为本地 Spring 事件桥（Kafka 化后换 producer 桥——表结构不变）；
 * 投递失败重试上限后标记 FAILED（人工介入），不阻塞后续事件。
 *
 * 崩滞恢复（2026-10-30 二轮收口）：投递方抢占事件后崩溃会滞留 DELIVERING——
 * 租约（lease_until = now()+60s）过期后由回收扫描置回 PENDING 继续投递。
 *
 * 与 Spring @EventListener 直连链路的差别：直连在进程重启后丢失（内存事件）；
 * Outbox 表持久化后重启可继续投递（02BE §2.1 建表联动的可靠版）。
 */
@Component
public class OutboxRelay {

    private static final int MAX_ATTEMPTS = 8;
    private static final int BATCH = 50;
    /** 租约时长秒：超时视为投递方崩溃，事件回收重投。 */
    private static final int LEASE_SECONDS = 60;

    private final JdbcTemplate jdbc;
    private final OutboxHandlerBridge bridge;

    public OutboxRelay(JdbcTemplate jdbc, OutboxHandlerBridge bridge) {
        this.jdbc = jdbc;
        this.bridge = bridge;
    }

    /** 业务事务内登记事件（由事件发布方调用——同事务原子提交）。 */
    public void enqueue(long tenantId, String topic, String payloadJson) {
        jdbc.update("""
                INSERT INTO outbox_event (tenant_id, topic, payload, status)
                VALUES (?, ?, ?::jsonb, 'PENDING')
                """, tenantId, topic, payloadJson);
    }

    /** 轮询投递：PENDING → DELIVERING（CAS + 租约）→ 消费 → DONE/FAILED。 */
    @Scheduled(fixedDelay = 3000)
    public void relay() {
        // 崩滞回收：租约过期的 DELIVERING 置回 PENDING（投递方崩溃后的恢复闭环）
        jdbc.update("UPDATE outbox_event SET status='PENDING', lease_until=NULL "
                + "WHERE status='DELIVERING' AND lease_until < now()");
        List<Map<String, Object>> pending = jdbc.queryForList(
                "SELECT id, topic, payload::text AS payload FROM outbox_event "
                        + "WHERE status='PENDING' ORDER BY id LIMIT " + BATCH);
        for (Map<String, Object> evt : pending) {
            long id = ((Number) evt.get("id")).longValue();
            // 抢占 CAS：多实例只有一个拿到；租约超时自动回收
            int claimed = jdbc.update(
                    "UPDATE outbox_event SET status='DELIVERING', attempts=attempts+1, "
                            + "lease_until=now() + interval '" + LEASE_SECONDS + " seconds' "
                            + "WHERE id=? AND status='PENDING'", id);
            if (claimed == 0) {
                continue;
            }
            try {
                bridge.deliver(String.valueOf(evt.get("topic")),
                        String.valueOf(evt.get("payload")));
                jdbc.update("UPDATE outbox_event SET status='DONE', delivered_at=now(), "
                        + "lease_until=NULL WHERE id=?", id);
            } catch (Exception e) {
                int attempts = attemptCount(id);
                String next = attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING";
                jdbc.update("UPDATE outbox_event SET status=?, lease_until=NULL WHERE id=?",
                        next, id);
            }
        }
    }

    private int attemptCount(long id) {
        Integer n = jdbc.queryForObject(
                "SELECT attempts FROM outbox_event WHERE id=?", Integer.class, id);
        return n == null ? MAX_ATTEMPTS : n;
    }

    /** 消费桥接口（组合根装配：Spring 事件桥 / Kafka producer 桥）。 */
    public interface OutboxHandlerBridge {
        void deliver(String topic, String payloadJson);
    }
}
