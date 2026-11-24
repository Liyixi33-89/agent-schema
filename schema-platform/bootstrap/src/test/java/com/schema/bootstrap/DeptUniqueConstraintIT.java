package com.schema.bootstrap;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.TestPropertySource;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * V20 收口验证：sys_dept 的 (tenant_id, path) 唯一约束**真的生效**。
 *
 * 为什么需要独立 IT：
 * 这个约束是「防重复部门」的唯一防线——重复会让按 path 查子树返回多行，
 * 下游 queryForObject 直接 IncorrectResultSize。只在迁移里写 CREATE UNIQUE INDEX
 * 而不验证「插入第二行确实失败」，等于没证明防线有效
 * （索引名拼错、被后建索引覆盖、NULL 例外写错都可能让约束静默失效）。
 *
 * ⚠️ 本 IT 只读用 Flowable 无关，不需要 ACT_* 表。
 */
@SpringBootTest(classes = com.schema.bootstrap.SchemaApplication.class)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(properties = {
        "spring.datasource.url=jdbc:postgresql://${IT_DB_HOST:localhost}:${IT_DB_PORT:5432}/${IT_DB_NAME:schema_dev}",
        "spring.datasource.username=${IT_DB_USER:schema_dev}",
        "spring.datasource.password=${IT_DB_PASS:schema_local_only}"
})
class DeptUniqueConstraintIT {

    private static final long TENANT = 922;
    private static final String PATH = "/922/";

    @Autowired
    private JdbcTemplate jdbc;

    @BeforeAll
    @AfterAll
    void cleanup() {
        doCleanup();
    }

    /** 每个用例前也清一次——用例之间共享 (tenant, path)，不隔离会互相撞唯一约束。 */
    @org.junit.jupiter.api.BeforeEach
    void beforeEach() {
        doCleanup();
    }

    private void doCleanup() {
        jdbc.update("UPDATE sys_user SET dept_id = NULL WHERE tenant_id = ?", TENANT);
        jdbc.update("DELETE FROM sys_dept WHERE tenant_id IN (?, ?)", TENANT, TENANT + 1);
    }

    /** 唯一索引确实存在（先证迁移落地）。 */
    @Test
    void V20_唯一索引存在() {
        Long n = jdbc.queryForObject(
                "SELECT count(*) FROM pg_indexes "
                + "WHERE tablename = 'sys_dept' AND indexname = 'uq_sys_dept_tenant_path'",
                Long.class);
        assertEquals(1L, n, "V20 唯一索引必须存在");

        String def = jdbc.queryForObject(
                "SELECT indexdef FROM pg_indexes "
                + "WHERE tablename = 'sys_dept' AND indexname = 'uq_sys_dept_tenant_path'",
                String.class);
        assertTrue(def != null && def.toLowerCase().contains("unique"),
                "索引必须是 UNIQUE: " + def);
        assertTrue(def.toLowerCase().contains("tenant_id") && def.toLowerCase().contains("path"),
                "索引应覆盖 (tenant_id, path): " + def);
    }

    /** 同租户同 path 第二次插入必须失败。 */
    @Test
    void V20_同租户同path重复插入被拒() {
        jdbc.update("INSERT INTO sys_dept (tenant_id, path, name) VALUES (?, ?, '唯一部')",
                TENANT, PATH);

        DuplicateKeyException e = assertThrows(DuplicateKeyException.class, () ->
                jdbc.update("INSERT INTO sys_dept (tenant_id, path, name) VALUES (?, ?, '重复部')",
                        TENANT, PATH));
        assertTrue(e.getMessage() != null, "应因唯一约束冲突失败");

        // 确实只有一行
        Long n = jdbc.queryForObject(
                "SELECT count(*) FROM sys_dept WHERE tenant_id = ? AND path = ?",
                Long.class, TENANT, PATH);
        assertEquals(1L, n, "重复插入不得留下第二行");
    }

    /** 不同租户同 path 允许（约束是租户内唯一，不是全局唯一）。 */
    @Test
    void V20_跨租户同path允许() {
        jdbc.update("INSERT INTO sys_dept (tenant_id, path, name) VALUES (?, ?, 'A租户部')",
                TENANT, PATH);
        // 另一个租户用相同 path —— 应成功
        jdbc.update("INSERT INTO sys_dept (tenant_id, path, name) VALUES (?, ?, 'B租户部')",
                TENANT + 1, PATH);

        Long n = jdbc.queryForObject(
                "SELECT count(*) FROM sys_dept WHERE path = ? AND tenant_id IN (?, ?)",
                Long.class, PATH, TENANT, TENANT + 1);
        assertEquals(2L, n, "跨租户同 path 应允许");

        jdbc.update("DELETE FROM sys_dept WHERE tenant_id = ?", TENANT + 1);
    }

    /** NULL path 不参与唯一性（历史数据兼容，不阻塞迁移）。 */
    @Test
    void V20_nullPath不受约束限制() {
        // 两行 NULL path 应都能插入（UNIQUE 对 NULL 不生效）
        jdbc.update("INSERT INTO sys_dept (tenant_id, path, name) VALUES (?, NULL, '无路径A')", TENANT);
        jdbc.update("INSERT INTO sys_dept (tenant_id, path, name) VALUES (?, NULL, '无路径B')", TENANT);

        Long n = jdbc.queryForObject(
                "SELECT count(*) FROM sys_dept WHERE tenant_id = ? AND path IS NULL",
                Long.class, TENANT);
        assertEquals(2L, n, "NULL path 不受唯一约束限制（SQL 标准语义）");

        // 但 V20 迁移里的孤儿清理只针对「无用户挂靠」的 NULL path——这是迁移期一次性动作，
        // 运行期不主动删，故此处能插入成功
        jdbc.update("DELETE FROM sys_dept WHERE tenant_id = ? AND path IS NULL", TENANT);
    }

    /** 按 path 查部门现在能保证单行（修复前的真实故障场景）。 */
    @Test
    void V20_按path查询返回单行() {
        jdbc.update("INSERT INTO sys_dept (tenant_id, path, name) VALUES (?, ?, '单行部')",
                TENANT, PATH);

        // 修复前：可能返回多行 → queryForObject 抛 IncorrectResultSize；
        // 修复后：唯一约束保证单行
        Long id = jdbc.queryForObject(
                "SELECT id FROM sys_dept WHERE tenant_id = ? AND path = ?",
                Long.class, TENANT, PATH);
        assertTrue(id != null && id > 0);

        List<Long> all = jdbc.queryForList(
                "SELECT id FROM sys_dept WHERE tenant_id = ? AND path = ?",
                Long.class, TENANT, PATH);
        assertEquals(1, all.size(), "按 path 查部门必须恰好一行");
    }
}