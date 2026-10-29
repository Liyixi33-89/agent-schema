package com.schema.data.application;

import com.schema.data.infrastructure.table.PhysicalTableManager;
import com.schema.platform.common.json.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
 * 后，由本组件轮询消费（5s 一次）。幂等键 data_promote_task(model_id, field_key)；
 * Kafka 化（ddl.promote topic）随事件基建（M5 后分期）。
 *
 * 失败处理：promote_status='FAILED'，任务可重试；期间查询自动回退 JSONB 表达式
 * （SqlBuilder.fieldExpr 判定 promoted() 失败即走 data->> 表达式——回退免费获得）。
 */
@Component
public class PromoteTaskConsumer {

    private static final Logger log = LoggerFactory.getLogger(PromoteTaskConsumer.class);

    private final JdbcTemplate jdbc;
    private final PhysicalTableManager tables;

    public PromoteTaskConsumer(JdbcTemplate jdbc, PhysicalTableManager tables) {
        this.jdbc = jdbc;
        this.tables = tables;
    }

    /** 轮询消费（幂等；独立事务——单任务失败不污染批次）。 */
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
                consumeOne(tenantId, modelId, fieldKey, fieldType);
                jdbc.update("UPDATE meta_field SET promote_status='ACTIVE' WHERE id=?", fieldRowId);
            } catch (Exception e) {
                jdbc.update("UPDATE meta_field SET promote_status='FAILED' WHERE id=?", fieldRowId);
                log.warn("提升列任务失败（查询自动回退 JSONB 表达式）: model={} field={} cause={}",
                        modelId, fieldKey, e.getMessage());
            }
        }
    }

    /** 单任务执行（登记行 CAS PENDING→BUILDING 防双实例并发重复消费）。 */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void consumeOne(long tenantId, long modelId, String fieldKey, String fieldType) {
        // 幂等登记：唯一键 (model_id, field_key)；重复任务 ACK
        jdbc.update("""
                INSERT INTO data_promote_task (tenant_id, model_id, field_key, status, attempts)
                VALUES (?, ?, ?, 'BUILDING', 1)
                ON CONFLICT (model_id, field_key) DO UPDATE
                SET status='BUILDING', attempts=data_promote_task.attempts+1, updated_at=now()
                WHERE data_promote_task.status <> 'ACTIVE'
                """, tenantId, modelId, fieldKey);
        tables.addPromotedColumn(tenantId, modelId, fieldKey, fieldType);
        jdbc.update("UPDATE data_promote_task SET status='ACTIVE', updated_at=now() "
                + "WHERE model_id=? AND field_key=?", modelId, fieldKey);
    }
}
