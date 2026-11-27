package com.schema.bootstrap;

import org.springframework.jdbc.core.JdbcTemplate;

import java.util.Set;

/**
 * IT 数据库防误伤闸（2026-11-26 事故后加，2026-11-27 收紧并全量覆盖）。
 *
 * ## 背景
 * 多个 IT 的初始化会清空业务表建立干净种子，例如：
 * - {@code IamServiceIT} / {@code IamSecurityChainIT}：无条件 DELETE 用户/角色/租户
 * - {@code AppServiceIT}：删除应用、公告、应用角色
 * - {@code DataEngineIT} / {@code DataEngineSecurityIT}：删除元数据并 DROP 动态物理表
 * - {@code MeteringIT}：23 处 DELETE/清理
 *
 * 这些清理一旦落在**有真实数据的库**上（验收库 schema_acceptance / 生产库
 * schema_prod / 开发库 schema_dev），会造成不可逆的数据丢失。
 * 2026-11-25 验收库就因此丢了 112 个页面与全部真实应用。
 *
 * ## 判定规则（2026-11-27 从子串匹配收紧）
 * 旧实现用 {@code contains("_it")}，会把 {@code schema_items}、
 * {@code production_test_backup} 这类库误判为安全——**子串不代表安全**。
 *
 * 新规则（按优先级）：
 * 1. 显式允许清单 {@link #EXPLICIT_ALLOW}（当前仅 schema_it）
 * 2. 显式拒绝清单 {@link #EXPLICIT_DENY}（真实库，即使名字像测试库也拒绝）
 * 3. 库名整体匹配 {@code ^(test|it|ci)(_[a-z0-9]+)*$} 或 {@code ^[a-z0-9]+_(it|test)$}
 *    （整名匹配，不是子串）
 *
 * 一律不匹配则拒绝——**宁可测试跑不了，也不能清掉别人的数据**。
 *
 * ## 覆盖方式
 * {@link ItDbGuardExtension} 注册为 JUnit 5 自动检测扩展，
 * 任何 IT 类启动前都会先过闸，无需逐个类改代码（新增 IT 自动受保护）。
 */
public final class ItDbGuard {

    /** 明确允许（唯一生产认证的 IT 库）。 */
    private static final Set<String> EXPLICIT_ALLOW = Set.of("schema_it");

    /**
     * 明确拒绝：真实数据所在库。
     *
     * 即使未来有人给它们起个「像测试库」的名字也不放行——
     * schema_dev 在 CI 是一次性容器库、在服务器上是真实开发库，
     * 同名两义正是 2026-11-25 事故的根源，因此这里硬性拒绝。
     */
    private static final Set<String> EXPLICIT_DENY = Set.of(
            "schema_acceptance", "schema_prod", "schema_dev", "postgres", "template0", "template1");

    private ItDbGuard() {}

    /**
     * 判断库名是否允许破坏性清理（纯函数，便于单测）。
     *
     * @param dbName 当前连接的数据库名（{@code current_database()}）
     * @return 允许返回 true
     */
    public static boolean isDestructiveAllowed(String dbName) {
        if (dbName == null || dbName.isBlank()) return false;
        String n = dbName.trim().toLowerCase();

        if (EXPLICIT_ALLOW.contains(n)) return true;
        if (EXPLICIT_DENY.contains(n)) return false;

        // 整名匹配（不是子串）：
        //   test / it / ci 开头，后续每段为 [a-z0-9]+  → test_foo / ci_abc / it_x
        //   或 <name>_it / <name>_test 结尾            → foo_it / foo_test
        if (n.matches("^(test|it|ci)(_[a-z0-9]+)*$")) return true;
        if (n.matches("^[a-z0-9]+(_[a-z0-9]+)*_(it|test)$")) return true;
        return false;
    }

    // ------------------------------------------------------------------
    // 第二道闸：无 WHERE 的全表 DELETE / TRUNCATE
    // ------------------------------------------------------------------

    /**
     * 判断 SQL 是否为「无 WHERE 的全表清空」。
     *
     * 实现说明：先匹配清空语句的**开头**（DELETE FROM x / TRUNCATE [TABLE] x），
     * 再检查**整条语句**是否出现 WHERE 关键字。
     * 不用单条复杂正则——`.*$` 配合 DOTALL 会贪婪吞掉 WHERE，实测误判。
     */
    static boolean isFullTableWipe(String sql) {
        if (sql == null) return false;
        String s = sql.trim();
        java.util.regex.Matcher head = java.util.regex.Pattern
                .compile("^(?:DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?)\\s+[\\w.\"]+",
                        java.util.regex.Pattern.CASE_INSENSITIVE)
                .matcher(s);
        if (!head.find()) return false;                     // 不是清空语句
        return !java.util.regex.Pattern.compile("\\bWHERE\\b",
                java.util.regex.Pattern.CASE_INSENSITIVE).matcher(s).find();
    }

    /**
     * 断言 SQL 不是「无 WHERE 的全表清空」。
     *
     * 与 {@link #assertDestructiveAllowed(JdbcTemplate)} 互补：
     * 那道闸问「这个库能不能动」，本闸问「这条语句该不该这么写」。
     * 两者都过才执行清理。
     *
     * @param sql 即将执行的 SQL
     * @throws IllegalStateException 无 WHERE 清空且未显式放行
     */
    public static void assertScopedStatement(String sql) {
        if (!isFullTableWipe(sql)) return;

        boolean override = "true".equalsIgnoreCase(System.getProperty("it.allow-full-table-delete"))
                || "true".equalsIgnoreCase(System.getenv("IT_ALLOW_FULL_TABLE_DELETE"));
        if (override) {
            System.err.println("[ItDbGuard] \u26a0\ufe0f 已显式放行全表清空：" + sql.trim());
            return;
        }
        throw new IllegalStateException(
                "IT 防误伤闸：拒绝执行「无 WHERE 的全表清空」：\n  " + sql.trim() + "\n"
                        + "  这类语句会清掉同库其他测试甚至真实数据——\n"
                        + "  2026-11-26 验收库的真实应用/模型就是这样被清掉的。\n"
                        + "  请改用带条件的清理（限定 tenant_id / 测试数据 key 前缀 / 本次创建的 id）。\n"
                        + "  确需清全表时显式加 -Dit.allow-full-table-delete=true。");
    }

    /**
     * 断言当前连接的库允许执行破坏性清理。
     *
     * @param jdbc 已注入的数据源（用于读 current_database()）
     * @throws IllegalStateException 库名不被允许且未显式放行时
     */
    public static void assertDestructiveAllowed(JdbcTemplate jdbc) {
        String dbName;
        try {
            dbName = jdbc.queryForObject("SELECT current_database()", String.class);
        } catch (Exception e) {
            throw new IllegalStateException(
                    "IT 防误伤闸：无法读取当前库名，拒绝执行破坏性清理", e);
        }
        assertDestructiveAllowed(dbName);
    }

    /**
     * 按库名断言（无 JdbcTemplate 的场景，如 JUnit 扩展启动时）。
     *
     * @param dbName 目标库名
     */
    public static void assertDestructiveAllowed(String dbName) {
        boolean override = "true".equalsIgnoreCase(System.getProperty("it.allow-destructive-db"))
                || "true".equalsIgnoreCase(System.getenv("IT_ALLOW_DESTRUCTIVE_DB"));
        if (override) {
            System.err.println("[ItDbGuard] ⚠️ 已显式放行破坏性清理：db=" + dbName
                    + "（it.allow-destructive-db=true）");
            return;
        }
        if (isDestructiveAllowed(dbName)) return;

        throw new IllegalStateException(
                "IT 防误伤闸：拒绝在库 '" + dbName + "' 上执行集成测试。\n"
                        + "  多个 IT 会清空业务表（用户/角色/应用/元数据/动态表），只允许在测试专用库运行。\n"
                        + "  允许：schema_it，或整名匹配 test*/it*/ci* 或 *_it / *_test 的库。\n"
                        + "  拒绝：schema_acceptance / schema_prod / schema_dev / postgres（真实数据库）。\n"
                        + "  请将 IT 指向测试库：\n"
                        + "    -DIT_DB_NAME=schema_it -DIT_DB_USER=schema_it -DIT_DB_PASS=...\n"
                        + "  若确需在当前库执行（危险，且会清空数据），显式加 -Dit.allow-destructive-db=true");
    }
}