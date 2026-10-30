package com.schema.data.application;

import com.schema.data.infrastructure.table.PhysicalTableManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Lazy;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;

/**
 * 提升列任务消费器（02BE §4）：PENDING → BUILDING → ACTIVE/FAILED 状态机。
 *
 * MVP 无 MQ：M2 saveSchema 的 collectPendingPromotions 置 meta_field.promote_status='PENDING'
 * 后，由本组件轮询消费（5s 一次）。Kafka 化（ddl.promote topic）随事件基建分期。
 *
 * 并发收口（2026-10-30）：
 * - poll() 经 @Lazy 自代理调用 consumeOne()（同类内部直调绕过 Spring 代理，
 *   REQUIRES_NEW 不生效——M5 审查缺口）；
 * - 抢占 CAS：UPDATE ... WHERE promote_status='PENDING' 判受影响行数，
 *   未抢到（他实例已 BUILDING/ACTIVE）跳过——不再误置 FAILED；
 * - 列已存在（DDL 幂等冲突）→ 视作列建成，补建缺失索引后置 ACTIVE；
 * - FAILED 状态回 PENDING 走人工/重试闸门（attempts 累计），查询自动回退 JSONB 表达式。
 */
@Component
public class PromoteTaskConsumer {

    private static final Logger log = LoggerFactory.getLogger(PromoteTaskConsumer.class);
    private static final int MAX_ATTEMPTS = 5;

    private final JdbcTemplate jdbc;
    private final PhysicalTableManager tables;
    /** @Lazy 自代理：poll() 必须经代理调用 consumeOne() 才能触发 REQUIRES_NEW。 */
    private final PromoteTaskConsumer self;

    public PromoteTaskConsumer(JdbcTemplate jdbc, PhysicalTableManager tables,
            @Lazy PromoteTaskConsumer self) {
        this.jdbc = jdbc;
        this.tables = tables;
        this.self = self;
    }

    /** 轮询消费（幂等；单任务独立事务——失败不污染批次）。 */
    @Scheduled(fixedDelay = 5000)
    public void poll() {
        List<Map<String, Object>> pending = jdbc.queryForList("""
                SELECT f.id AS field_row_id, f.tenant_id, f.model_id, f.field_key, f.field_type
                FROM meta_field f
                WHERE f.promote_status = 'PENDING' AND f.field_status = 'ACTIVE'
                LIMIT 20
                """);
        for (Map<String, Object> task : pending) {
            long fieldRowId = ((Number) task.get("field_row_id")).longValue();
            long tenantId = ((Number) task.get("tenant_id")).longValue();
            long modelId = ((Number) task.get("model_id")).longValue();
            String fieldKey = (String) task.get("field_key");
            String fieldType = (String) task.get("field_type");
            try {
                // 经代理调用（REQUIRES_NEW 生效——内部直调会绕过事务边界）
                boolean done = self.consumeOne(tenantId, modelId, fieldKey, fieldType);
                if (done) {
                    jdbc.update("UPDATE meta_field SET promote_status='ACTIVE' WHERE id=?",
                            fieldRowId);
                }
                // done=false：他实例抢占（BUILDING）或已达重试上限——本轮跳过，等下轮
            } catch (Exception e) {
                int updated = jdbc.update(
                        "UPDATE meta_field SET promote_status='FAILED' WHERE id=?", fieldRowId);
                log.warn("提升列任务失败（查询自动回退 JSONB 表达式）: model={} field={} rows={} cause={}",
                        modelId, fieldKey, updated, e.getMessage());
            }
        }
    }

    /**
     * 单任务执行（独立事务）。
     *
     * @return true = 任务完成（置 ACTIVE）；false = 未抢占（他实例持有）或重试耗尽——跳过
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public boolean consumeOne(long tenantId, long modelId, String fieldKey, String fieldType) {
        // 任务登记行幂等 upsert（唯一键 model_id+field_key）
        jdbc.update("""
                INSERT INTO data_promote_task (tenant_id, model_id, field_key, status, attempts)
                VALUES (?, ?, ?, 'PENDING', 0)
                ON CONFLICT (model_id, field_key) DO NOTHING
                """, tenantId, modelId, fieldKey);
        // 抢占 CAS：仅 PENDING → BUILDING 成功；受影响行数=0 表示他实例已持有或已完成
        int claimed = jdbc.update("""
                UPDATE data_promote_task
                SET status='BUILDING', attempts=attempts+1, updated_at=now()
                WHERE model_id=? AND field_key=? AND status='PENDING' AND attempts < ?
                """, modelId, fieldKey, MAX_ATTEMPTS);
        if (claimed == 0) {
            return false; // 未抢占：BUILDING/ACTIVE 或重试耗尽——不误置 FAILED
        }
        try {
            tables.addPromotedColumn(tenantId, modelId, fieldKey, fieldType);
        } catch (org.springframework.dao.DuplicateKeyException
                | org.springframework.jdbc.UncategorizedSQLException dup) {
            // 列已存在（DDL 幂等冲突——此前失败后列残留）：补建缺失索引后视作建成
            if (!dup.getMessage().toLowerCase().contains("already exists")) {
                throw dup;
            }
            log.info("提升列已存在，补建索引: model={} field={}", modelId, fieldKey);
            tables.ensurePromotedIndex(tenantId, modelId, fieldKey);
        }
        jdbc.update("UPDATE data_promote_task SET status='ACTIVE', updated_at=now() "
                + "WHERE model_id=? AND field_key=? AND status='BUILDING'", modelId, fieldKey);
        return true;
    }
}
