package com.schema.bootstrap;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 记录访问适配器的语义测试（不起 Spring，用桩引擎）。
 *
 * 守住两件事：
 * 1. 「不可见」与「不存在」都翻译成 false（不泄露记录是否存在）
 * 2. 基础设施异常**不能**被吞成「无权限」（否则故障伪装成权限拒绝）
 */
class RecordAccessAdapterTest {

    /** 可控的引擎桩：只关心 getById 抛什么。 */
    private static final class StubEngine extends com.schema.data.application.DynamicQueryEngine {
        private final RuntimeException toThrow;

        StubEngine(RuntimeException toThrow) {
            // 全 null 构造：只要不调用除 getById 以外的方法就安全（本测只测翻译逻辑）
            super(null, null, null, null, null, null);
            this.toThrow = toThrow;
        }

        @Override
        public java.util.Map<String, Object> getById(long modelId, long id) {
            if (toThrow != null) throw toThrow;
            return java.util.Map.of("id", id);
        }
    }

    /** 造一个带 code 的业务异常（复用真实 BizException 形态）。 */
    private static RuntimeException bizException(String code) {
        return new com.schema.platform.common.web.BizException(code, "stub");
    }

    @Test
    @DisplayName("记录可见 → true")
    void accessibleWhenFound() {
        RecordAccessAdapter adapter = new RecordAccessAdapter(new StubEngine(null), true);
        assertTrue(adapter.canAccess(1L, 10L, 5L, 100L));
    }

    @Test
    @DisplayName("🔴 同租户不可见记录 → false（授权缺口核心断言）")
    void notAccessibleWhenNotFound() {
        // 引擎对「不存在 / 已删除 / 不在数据范围」统一抛 RECORD_NOT_FOUND
        RecordAccessAdapter adapter =
                new RecordAccessAdapter(new StubEngine(bizException("RECORD_NOT_FOUND")), true);
        assertFalse(adapter.canAccess(1L, 20L, 5L, 100L),
                "同租户另一用户的记录必须判为不可访问");
    }

    @Test
    @DisplayName("NOT_FOUND 变体也识别为不可访问")
    void notAccessibleForNotFoundVariants() {
        for (String code : new String[]{"NOT_FOUND", "record_not_found"}) {
            RecordAccessAdapter adapter =
                    new RecordAccessAdapter(new StubEngine(bizException(code)), true);
            assertFalse(adapter.canAccess(1L, 10L, 5L, 1L), code + " 应判不可访问");
        }
    }

    @Test
    @DisplayName("基础设施异常必须上抛，不能伪装成无权限")
    void infrastructureFailurePropagates() {
        RecordAccessAdapter adapter = new RecordAccessAdapter(
                new StubEngine(new IllegalStateException("connection refused")), true);
        // 抛出去让上层 fail-closed 并记录真实原因
        assertThrows(IllegalStateException.class,
                () -> adapter.canAccess(1L, 10L, 5L, 100L),
                "DB 故障不是权限问题，必须冒泡");
    }

    @Test
    @DisplayName("包装过的 NOT_FOUND（cause 链）也能识别")
    void detectsWrappedNotFound() {
        RuntimeException wrapped = new RuntimeException("wrapper",
                bizException("RECORD_NOT_FOUND"));
        RecordAccessAdapter adapter = new RecordAccessAdapter(new StubEngine(wrapped), true);
        assertFalse(adapter.canAccess(1L, 10L, 5L, 100L));
    }

    @Test
    @DisplayName("ALLOW_ALL 降级实现（仅单测用）")
    void allowAllStub() {
        assertDoesNotThrow(() ->
                assertTrue(com.schema.flow.application.RecordAccessPort.ALLOW_ALL
                        .canAccess(1L, 1L, 1L, 1L)));
    }

    @Test
    @DisplayName("flow.record-access.enabled=false 时跳过校验（仅集成测试用）")
    void disabledSkipsCheck() {
        // FlowIT 用固定假 recordId 验证引擎状态机，没有物理表数据；
        // 该开关只给这类 IT 用，生产必须保持 true。
        RecordAccessAdapter adapter = new RecordAccessAdapter(
                new StubEngine(bizException("RECORD_NOT_FOUND")), false);
        assertTrue(adapter.canAccess(1L, 10L, 5L, 7001L),
                "关闭授权后不再查库，直接放行（引擎状态机测试依赖此行为）");
    }

    @Test
    @DisplayName("默认启用授权（构造器缺省值必须是 true）")
    void enabledByDefault() {
        // 编译期保证：@Value("${flow.record-access.enabled:true}")
        // 这里断言 Spring 默认值语义——若有人改成 :false，本条会失效提醒。
        java.lang.reflect.Constructor<?>[] ctors = RecordAccessAdapter.class.getConstructors();
        boolean found = false;
        for (java.lang.reflect.Constructor<?> c : ctors) {
            for (java.lang.annotation.Annotation[] anns : c.getParameterAnnotations()) {
                for (java.lang.annotation.Annotation a : anns) {
                    if (a instanceof org.springframework.beans.factory.annotation.Value v
                            && v.value().contains("flow.record-access.enabled:true")) {
                        found = true;
                    }
                }
            }
        }
        assertTrue(found, "默认值必须为 true（生产不能靠显式配置才有授权）");
    }
}