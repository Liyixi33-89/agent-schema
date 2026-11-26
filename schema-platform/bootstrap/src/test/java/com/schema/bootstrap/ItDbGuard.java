package com.schema.bootstrap;

import org.springframework.jdbc.core.JdbcTemplate;

/**
 * IT 数据库防误伤闸（2026-11-26 事故后加）。
 *
 * ## 背景
 * `IamServiceIT` / `IamSecurityChainIT` 的 {@code @BeforeAll} 需要清空 IAM 表
 * 建立干净种子。这些 DELETE 是无条件的——一旦 IT 连到**有真实数据的库**
 * （验收库 schema_acceptance / 生产库 schema_prod），会把租户、用户、角色全部抹掉。
 *
 * 2026-11-25 验收库就因此丢了 112 个页面与全部真实应用（只能从更早备份恢复）。
 *
 * ## 闸门语义
 * 清库前必须**显式声明目标库名**，且库名要匹配「测试库」白名单模式：
 * - 含 {@code _it} / {@code _test}（如 schema_it）
 * - 或以 {@code test} 开头
 *
 * 不匹配则直接 fail-fast 抛错——**宁可测试跑不了，也不能清掉别人的数据**。
 * 紧急情况下若确需在特殊库上跑，可通过 {@code -Dit.allow-destructive-db=true}
 * 显式放行（该开关不进 CI，属于人工救急通道）。
 */
final class ItDbGuard {

    /** 允许被清空的库名模式（只认测试专用命名）。 */
    private static final String[] SAFE_PATTERNS = {"_it", "_test", "test_"};

    private ItDbGuard() {}

    /**
     * 断言当前连接的库允许执行破坏性清理。
     *
     * @param jdbc 已注入的数据源（用于读 current_database()）
     * @throws IllegalStateException 库名不像测试库且未显式放行时
     */
    static void assertDestructiveAllowed(JdbcTemplate jdbc) {
        boolean override = "true".equalsIgnoreCase(System.getProperty("it.allow-destructive-db"))
                || "true".equalsIgnoreCase(System.getenv("IT_ALLOW_DESTRUCTIVE_DB"));
        String dbName;
        try {
            dbName = jdbc.queryForObject("SELECT current_database()", String.class);
        } catch (Exception e) {
            throw new IllegalStateException(
                    "IT 防误伤闸：无法读取当前库名，拒绝执行清库操作", e);
        }
        if (override) {
            System.err.println("[ItDbGuard] ⚠️ 已显式放行破坏性清理：db=" + dbName
                    + "（it.allow-destructive-db=true）");
            return;
        }
        String lower = dbName == null ? "" : dbName.toLowerCase();
        for (String p : SAFE_PATTERNS) {
            if (lower.contains(p) || lower.startsWith(p)) {
                return;   // 测试专用库，放行
            }
        }
        throw new IllegalStateException(
                "IT 防误伤闸：拒绝在库 '" + dbName + "' 上执行破坏性清理。\n"
                        + "  该 IT 会 DELETE 全部用户/角色/租户数据，只允许在测试专用库运行。\n"
                        + "  请将 IT 指向 schema_it 或 *_test 库：\n"
                        + "    -DIT_DB_NAME=schema_it -DIT_DB_USER=schema_it -DIT_DB_PASS=...\n"
                        + "  若确需在当前库执行（危险），显式加 -Dit.allow-destructive-db=true");
    }
}