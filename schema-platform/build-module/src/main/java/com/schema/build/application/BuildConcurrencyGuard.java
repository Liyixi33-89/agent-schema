package com.schema.build.application;

import org.springframework.stereotype.Component;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 单租户构建并发守卫（04BE §2.4：并发上限 + 队列隔离）。
 * 单容器 Worker（P1 无 HPA）——进程内计数即真实并发；分布式队列随 P2 Worker 池落地。
 */
@Component
public class BuildConcurrencyGuard {

    private final ConcurrentHashMap<Long, AtomicInteger> inflight = new ConcurrentHashMap<>();

    public boolean tryAcquire(long tenantId, int limit) {
        AtomicInteger n = inflight.computeIfAbsent(tenantId, k -> new AtomicInteger());
        for (;;) {
            int cur = n.get();
            if (cur >= limit) return false;
            if (n.compareAndSet(cur, cur + 1)) return true;
        }
    }

    public void release(long tenantId) {
        AtomicInteger n = inflight.get(tenantId);
        if (n != null && n.decrementAndGet() <= 0) {
            inflight.remove(tenantId, n);
        }
    }
}
