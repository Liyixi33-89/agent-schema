package com.schema.data.domain.engine;

import com.schema.data.domain.repository.MetadataPort.ModelMeta;
import com.schema.platform.common.web.BizException;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 聚合护栏三轮收口回归（2026-10-30）：
 * OR 组界保守拒绝 / 月份真实历法换算 / 单边范围拒绝 / 界颠倒拒绝。
 */
class AggregateBuilderTest {

    private static ModelMeta model() {
        return new ModelMeta(1L, 1L, 1L, "m", "m", "ACTIVE", 3);
    }

    @Test
    void orGroupBoundsRejected() {
        // OR 组内出现桶字段界 → 保守拒绝（并集区间不可证明连续窄跨度）
        Map<String, Object> orFilter = Map.of("op", "OR", "conds", List.of(
                Map.of("field", "created_day", "op", "gte", "value", "2026-01-01"),
                Map.of("field", "created_day", "op", "lte", "value", "2036-01-01")));
        BizException e = assertThrows(BizException.class, () ->
                AggregateBuilder.guardBucketSpan(model(), "created_day", "MONTH", orFilter));
        assertTrue(e.getMessage().contains("OR"));
    }

    @Test
    void andGroupTightBoundsAccepted() {
        // AND 组双边窄范围 → 放行
        Map<String, Object> andFilter = Map.of("op", "AND", "conds", List.of(
                Map.of("field", "created_day", "op", "gte", "value", "2026-01-01"),
                Map.of("field", "created_day", "op", "lte", "value", "2026-03-01")));
        assertDoesNotThrow(() ->
                AggregateBuilder.guardBucketSpan(model(), "created_day", "MONTH", andFilter));
    }

    @Test
    void monthCountUsesRealCalendar() {
        // 10 年 = 121 月 → 放行
        Map<String, Object> filter = Map.of(
                "field", "created_day", "op", "between",
                "value", List.of("2016-01-01", "2026-01-15"));
        assertDoesNotThrow(() ->
                AggregateBuilder.guardBucketSpan(model(), "created_day", "MONTH", filter));

        // 82 年 = 985 月 ≤ 1000：放行（真实历法判定——近似 30.44 天在此长度会低估）
        Map<String, Object> wide = Map.of(
                "field", "created_day", "op", "between",
                "value", List.of("1944-06-01", "2026-06-15"));
        assertDoesNotThrow(() ->
                AggregateBuilder.guardBucketSpan(model(), "created_day", "MONTH", wide));

        // 84 年 = 1009 月 > 1000 → 拒绝
        Map<String, Object> over = Map.of(
                "field", "created_day", "op", "between",
                "value", List.of("1942-06-01", "2026-06-15"));
        assertThrows(BizException.class, () ->
                AggregateBuilder.guardBucketSpan(model(), "created_day", "MONTH", over));
    }

    @Test
    void singleSideBoundRejected() {
        Map<String, Object> filter = Map.of(
                "field", "created_day", "op", "gte", "value", "2026-01-01");
        assertThrows(BizException.class, () ->
                AggregateBuilder.guardBucketSpan(model(), "created_day", "MONTH", filter));
    }

    @Test
    void invertedRangeRejected() {
        Map<String, Object> filter = Map.of(
                "field", "created_day", "op", "between",
                "value", List.of("2026-06-01", "2026-01-01"));
        assertThrows(BizException.class, () ->
                AggregateBuilder.guardBucketSpan(model(), "created_day", "MONTH", filter));
    }
}
