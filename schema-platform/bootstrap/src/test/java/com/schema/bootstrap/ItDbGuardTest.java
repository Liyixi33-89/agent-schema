package com.schema.bootstrap;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * IT 防误伤闸的单元测试（不连数据库——用 mock JdbcTemplate 返回库名）。
 *
 * 覆盖 2026-11-25 验收库被 IT 清空的事故场景：
 * 库名不像测试库时必须拒绝，只有 *_it / *_test / test_* 才放行。
 */
class ItDbGuardTest {

    private static JdbcTemplate jdbcReturning(String dbName) {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        when(jdbc.queryForObject("SELECT current_database()", String.class)).thenReturn(dbName);
        return jdbc;
    }

    @Test
    @DisplayName("验收库 / 生产库一律拒绝（事故库名）")
    void rejectsRealDatabases() {
        for (String db : new String[]{"schema_acceptance", "schema_prod", "schema_dev", "postgres"}) {
            IllegalStateException e = assertThrows(IllegalStateException.class,
                    () -> ItDbGuard.assertDestructiveAllowed(jdbcReturning(db)),
                    "库 " + db + " 必须被拒绝");
            assertTrue(e.getMessage().contains(db), "错误信息应点名库名");
            assertTrue(e.getMessage().contains("schema_it"), "错误信息应给出正确用法");
        }
    }

    @Test
    @DisplayName("测试专用库放行")
    void allowsTestDatabases() {
        for (String db : new String[]{"schema_it", "schema_test", "test_schema", "MY_IT"}) {
            assertDoesNotThrow(() -> ItDbGuard.assertDestructiveAllowed(jdbcReturning(db)),
                    "库 " + db + " 应被放行");
        }
    }

    @Test
    @DisplayName("读不到库名时拒绝（不猜测）")
    void rejectsWhenDbNameUnavailable() {
        JdbcTemplate jdbc = mock(JdbcTemplate.class);
        when(jdbc.queryForObject("SELECT current_database()", String.class))
                .thenThrow(new RuntimeException("connection lost"));
        assertThrows(IllegalStateException.class,
                () -> ItDbGuard.assertDestructiveAllowed(jdbc));
    }

    @Test
    @DisplayName("显式放行开关（人工救急通道）")
    void overrideAllowsAnyDatabase() {
        System.setProperty("it.allow-destructive-db", "true");
        try {
            assertDoesNotThrow(() -> ItDbGuard.assertDestructiveAllowed(jdbcReturning("schema_acceptance")));
        } finally {
            System.clearProperty("it.allow-destructive-db");
        }
    }
}