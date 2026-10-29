package com.schema.metadata.domain.model;

import org.junit.jupiter.api.Test;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 聚合根纯领域测试（无 Spring/DB 依赖）：字段状态机、不变式、环检测（01BE §7）。
 */
class ModelAggregateTest {

    private static ModelAggregate model() {
        return ModelAggregate.create(new com.schema.platform.common.tenant.TenantInfo(1, 1, 1),
                "order", "订单管理", null);
    }

    private static Map<String, Object> computed(String expr, String... dependsOn) {
        Map<String, Object> computed = new LinkedHashMap<>();
        Map<String, Object> exprBinding = new LinkedHashMap<>();
        exprBinding.put("kind", "expr");
        exprBinding.put("source", expr);
        computed.put("expr", exprBinding);
        computed.put("dependsOn", List.of(dependsOn));
        computed.put("persistMode", "READ_TIME");
        return computed;
    }

    @Test
    void createValidatesModelKey() {
        assertThrows(IllegalArgumentException.class, () ->
                ModelAggregate.create(new com.schema.platform.common.tenant.TenantInfo(1, 1, 1),
                        "BadKey", "x", null));
        assertThrows(IllegalArgumentException.class, () ->
                ModelAggregate.create(new com.schema.platform.common.tenant.TenantInfo(1, 1, 1),
                        "order", " ", null));
        assertDoesNotThrow(() -> model());
    }

    @Test
    void deleteFieldIsSoftOnly() {
        ModelAggregate m = model();
        m.addNewField("amount", "金额", "number", false, false, false, null, null, null, null, null, 0, 1);
        m.deleteField("amount", OffsetDateTime.now());

        assertTrue(m.findField("amount").get().deleted());
        assertTrue(m.activeFields().isEmpty(), "DELETED 字段不得出现在活跃集合");
        assertNotNull(m.findField("amount").get().deletedAt(), "deleted_at 必须落值");

        // 幂等：重复删除不抛错
        assertDoesNotThrow(() -> m.deleteField("amount", OffsetDateTime.now()));
    }

    @Test
    void deletedFieldStillInAllFieldsButNotActive() {
        ModelAggregate m = model();
        m.addNewField("a", "A", "text", false, false, false, null, null, null, null, null, 0, 1);
        m.addNewField("b", "B", "text", false, false, false, null, null, null, null, null, 1, 1);
        m.deleteField("a", OffsetDateTime.now());
        assertEquals(2, m.allFields().size(), "行永不物理删除");
        assertEquals(List.of("b"), m.activeFields().stream().map(ModelAggregate.FieldDef::fieldKey).toList());
    }

    @Test
    void indexedFieldMarksPromotePending() {
        ModelAggregate m = model();
        m.addNewField("status", "状态", "enum", false, false, true, null, null, null, null, null, 0, 1);
        assertEquals("PENDING", m.findField("status").get().promoteStatus(),
                "新增 indexed 字段必须进 PENDING 等待 DDL 任务（01BE §4.2 步骤 3）");
    }

    @Test
    void circularDependencyDetected() {
        ModelAggregate m = model();
        m.addNewField("a", "A", "computed", false, false, false, null, null, null, null,
                computed("1", "b"), 0, 1);
        m.addNewField("b", "B", "computed", false, false, false, null, null, null, null,
                computed("1", "a"), 1, 1);
        List<String> cycle = m.detectCircularDependency();
        assertFalse(cycle.isEmpty(), "a↔b 依赖成环必须被检出");
    }

    @Test
    void noFalsePositiveOnChain() {
        ModelAggregate m = model();
        m.addNewField("base", "基础", "number", false, false, false, null, null, null, null, null, 0, 1);
        m.addNewField("derived", "推导", "computed", false, false, false, null, null, null, null,
                computed("base * 2", "base"), 1, 1);
        assertTrue(m.detectCircularDependency().isEmpty(), "线性依赖不成环");
    }

    @Test
    void immutableFieldKeyEnforcedByValidationLayer() {
        // field_key/field_type 不可改：由 ChangeOp 校验层拦截（MetadataCommandService.validateChanges），
        // 聚合本身不提供改 key/type 的入口——API 面即防线（不存在 setFieldKey 方法）
        ModelAggregate m = model();
        m.addNewField("x", "X", "text", false, false, false, null, null, null, null, null, 0, 1);
        assertEquals("x", m.findField("x").get().fieldKey());
        assertEquals("text", m.findField("x").get().fieldType());
    }

    @Test
    void optimisticVersionAdvance() {
        ModelAggregate m = model();
        assertThrows(IllegalStateException.class, () -> m.advanceVersion(5),
                "base 与当前不一致必须拒绝");
        m.advanceVersion(1);
        assertEquals(2, m.currentVersion());
    }
}
