package com.schema.data.infrastructure.outbox;

import com.schema.platform.common.json.Json;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * Outbox 消费桥 MVP 实现：投递为本地 Spring 事件（消费方按 topic 订阅）。
 * Kafka 化（ADR-001）后换 Kafka producer 桥——OutboxRelay/表结构不变。
 */
@Component
public class SpringEventBridge implements OutboxRelay.OutboxHandlerBridge {

    /** 本地投递事件（topic + payload——消费方按 topic 分发）。 */
    public record OutboxDelivered(String topic, Map<String, Object> payload) {
    }

    private final ApplicationEventPublisher publisher;

    public SpringEventBridge(ApplicationEventPublisher publisher) {
        this.publisher = publisher;
    }

    @Override
    public void deliver(String topic, String payloadJson) {
        publisher.publishEvent(new OutboxDelivered(topic, Json.readMap(payloadJson)));
    }
}
