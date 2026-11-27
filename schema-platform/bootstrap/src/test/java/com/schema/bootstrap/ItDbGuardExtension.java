package com.schema.bootstrap;

import org.junit.jupiter.api.extension.BeforeAllCallback;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.springframework.test.context.junit.jupiter.SpringExtension;
import org.springframework.context.ApplicationContext;

import javax.sql.DataSource;
import java.sql.Connection;

/**
 * IT 库闸自动应用（JUnit 5 自动检测扩展）。
 *
 * ## 为什么用扩展而不是逐类调用
 * 仓库里 17 个 {@code *IT.java} 都做破坏性清理，且没有共用基类。
 * 逐个加 {@code ItDbGuard.assertDestructiveAllowed(jdbc)} 有两个问题：
 * 1. 漏改就等于没保护（本次评审指出 AppServiceIT / DataEngineIT 就没覆盖）
 * 2. 新增 IT 时容易再次遗漏
 *
 * 注册为自动检测扩展后，**任何 IT 启动前**都会先确认连接目标是测试库，
 * 无需业务代码配合。
 *
 * ## 注册方式
 * 位于 {@code src/test/resources/META-INF/services/} 下的
 * {@code org.junit.jupiter.api.extension.Extension} 文件（ServiceLoader 自动加载）。
 *
 * ## 只对 IT 生效
 * 单元测试（{@code *Test}，不连库）无需过闸——类名以 {@code IT} 结尾才校验，
 * 避免把纯内存测试也拖进数据库依赖。
 */
public class ItDbGuardExtension implements BeforeAllCallback {

    private static final String FLAG = ItDbGuardExtension.class.getName() + ".checked";

    @Override
    public void beforeAll(ExtensionContext context) throws Exception {
        String className = context.getRequiredTestClass().getName();
        // 只拦集成测试（Surefire 用 *IT 命名区分）；普通 *Test 不连库
        if (!className.endsWith("IT")) {
            return;
        }

        // 同一 JVM 内多个 IT 共享 Spring 上下文：库名不会变，校验一次即可
        ExtensionContext root = context.getRoot();
        if (root.getStore(ExtensionContext.Namespace.GLOBAL).get(FLAG) != null) {
            return;
        }

        String dbName = resolveDatabaseName(context);
        ItDbGuard.assertDestructiveAllowed(dbName);
        root.getStore(ExtensionContext.Namespace.GLOBAL).put(FLAG, Boolean.TRUE);

        System.err.println("[ItDbGuard] ✔ 集成测试库校验通过: " + dbName
                + "（" + context.getRequiredTestClass().getSimpleName() + "）");
    }

    /**
     * 解析实际连接的库名。
     *
     * 优先从 Spring 上下文的 DataSource 取真实连接（最可信——就是测试会用的那个），
     * 取不到时回退到 {@code IT_DB_NAME} 系统属性/环境变量。
     */
    private String resolveDatabaseName(ExtensionContext context) {
        // 1. 真实数据源（唯一可信来源）
        try {
            ApplicationContext ctx = SpringExtension.getApplicationContext(context);
            DataSource ds = ctx.getBean(DataSource.class);
            try (Connection c = ds.getConnection()) {
                String name = c.getCatalog();
                if (name != null && !name.isBlank()) {
                    return name;
                }
            }
        } catch (Exception ignored) {
            // 上下文未就绪或非 Spring 测试——走回退
        }

        // 2. 配置项回退（与 IT 数据源注入链同一套键）
        String[] keys = {"IT_DB_NAME", "it.db.name"};
        for (String k : keys) {
            String v = System.getProperty(k);
            if (v == null || v.isBlank()) v = System.getenv(k);
            if (v != null && !v.isBlank()) return v;
        }

        // 3. 都拿不到 → 交给闸门拒绝（不猜测）
        return "";
    }
}