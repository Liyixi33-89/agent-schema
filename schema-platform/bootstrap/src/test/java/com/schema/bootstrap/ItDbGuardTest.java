package com.schema.bootstrap;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * IT 防误伤闸规则测试（纯函数，不连库）。
 *
 * 覆盖 2026-11-25 验收库被 IT 清空的事故场景，
 * 以及 2026-11-27 评审指出的子串匹配绕过（schema_items / production_test_backup）。
 */
class ItDbGuardTest {

    // ---------- 必须拒绝：真实库 ----------

    @Test
    @DisplayName("真实库一律拒绝（事故库名）")
    void rejectsRealDatabases() {
        for (String db : new String[]{
                "schema_acceptance", "schema_prod", "schema_dev", "postgres",
                "template0", "template1"}) {
            assertFalse(ItDbGuard.isDestructiveAllowed(db), "库 " + db + " 必须被拒绝");
        }
    }

    @Test
    @DisplayName("🔴 评审指出的子串绕过：schema_items 不得放行")
    void rejectsSubstringBypass() {
        // 旧实现 contains("_it") 会把这两个误判为安全——整名匹配后不再如此
        assertFalse(ItDbGuard.isDestructiveAllowed("schema_items"),
                "schema_items 含 _it 子串但不是测试库，必须拒绝");
        assertFalse(ItDbGuard.isDestructiveAllowed("production_test_backup"),
                "production_test_backup 含 _test 子串但是生产备份，必须拒绝");
        assertFalse(ItDbGuard.isDestructiveAllowed("my_it_prod"));
        assertFalse(ItDbGuard.isDestructiveAllowed("database_itx"));
    }

    @Test
    @DisplayName("空库名拒绝（不猜测）")
    void rejectsBlank() {
        assertFalse(ItDbGuard.isDestructiveAllowed(null));
        assertFalse(ItDbGuard.isDestructiveAllowed(""));
        assertFalse(ItDbGuard.isDestructiveAllowed("   "));
    }

    // ---------- 必须放行：测试库 ----------

    @Test
    @DisplayName("显式允许清单：schema_it")
    void allowsSchemaIt() {
        assertTrue(ItDbGuard.isDestructiveAllowed("schema_it"));
        assertTrue(ItDbGuard.isDestructiveAllowed("SCHEMA_IT"), "大小写不敏感");
    }

    @Test
    @DisplayName("整名匹配 test*/it*/ci* 前缀")
    void allowsTestPrefix() {
        assertTrue(ItDbGuard.isDestructiveAllowed("test_schema"));
        assertTrue(ItDbGuard.isDestructiveAllowed("it_platform"));
        assertTrue(ItDbGuard.isDestructiveAllowed("ci_verify"));
        assertTrue(ItDbGuard.isDestructiveAllowed("test"));
        assertTrue(ItDbGuard.isDestructiveAllowed("it"));
    }

    @Test
    @DisplayName("整名匹配 *_it / *_test 后缀")
    void allowsTestSuffix() {
        assertTrue(ItDbGuard.isDestructiveAllowed("foo_it"));
        assertTrue(ItDbGuard.isDestructiveAllowed("foo_bar_test"));
        assertTrue(ItDbGuard.isDestructiveAllowed("mydb_it"));
    }

    // ---------- 断言版（带异常信息） ----------

    @Test
    @DisplayName("assertDestructiveAllowed 拒绝时给出可操作提示")
    void assertGivesActionableMessage() {
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> ItDbGuard.assertDestructiveAllowed("schema_acceptance"));
        assertTrue(e.getMessage().contains("schema_acceptance"), "应点名库名");
        assertTrue(e.getMessage().contains("schema_it"), "应给出正确用法");
        assertTrue(e.getMessage().contains("it.allow-destructive-db"), "应说明救急开关");
    }

    @Test
    @DisplayName("isDestructiveAllowed 是纯规则判断，不受救急开关影响")
    void overrideDoesNotAffectPureRule() {
        System.setProperty("it.allow-destructive-db", "true");
        try {
            // 开关只作用于 assert 版（救急通道）；纯规则判断必须保持严格，
            // 否则规则本身会被临时状态污染，难以推理和测试。
            assertFalse(ItDbGuard.isDestructiveAllowed("schema_acceptance"));
        } finally {
            System.clearProperty("it.allow-destructive-db");
        }
    }

    @Test
    @DisplayName("assert 版：显式放行时对真实库不抛异常")
    void assertOverridePasses() {
        System.setProperty("it.allow-destructive-db", "true");
        try {
            // 真实库名默认拒绝，但 override 时不抛
            ItDbGuard.assertDestructiveAllowed("schema_prod");
        } finally {
            System.clearProperty("it.allow-destructive-db");
        }
    }
}