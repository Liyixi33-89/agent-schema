package com.schema.bootstrap;

import com.schema.app.application.AppService;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * theme 白名单双端共享样本（spec 019 §3 同判铁律）：
 * 消费前端 theme-engine/test/theme-fixtures.json 同一份真源——
 * 逐条断言 AppService.themeErrors 的判定与错误锚点，与前端 Vitest 同判。
 * 样本由本仓库相对路径读取（verify 环境工作目录 = schema-platform）。
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ThemeVectorTest {

    record Case(String id, String inputJson, boolean ok, List<String> errContains) {
    }

    private List<Case> loadCases() throws Exception {
        // 仓库根/schema-frontend/packages/theme-engine/test/theme-fixtures.json
        // 工作目录可能是 schema-platform 或 bootstrap——两形态都探测（surefire 取 module 目录）
        java.nio.file.Path fixture = java.nio.file.Paths.get(
                "..", "schema-frontend", "packages", "theme-engine", "test", "theme-fixtures.json");
        if (!java.nio.file.Files.exists(fixture)) {
            fixture = java.nio.file.Paths.get(
                    "..", "..", "schema-frontend", "packages", "theme-engine", "test", "theme-fixtures.json");
        }
        if (!java.nio.file.Files.exists(fixture)) {
            throw new IllegalStateException("共享样本缺失: " + fixture.toAbsolutePath());
        }
        String raw = java.nio.file.Files.readString(fixture, StandardCharsets.UTF_8);
        var root = JsonParser.parseString(raw).getAsJsonObject();
        List<Case> cases = new ArrayList<>();
        for (var e : root.getAsJsonArray("cases")) {
            var o = e.getAsJsonObject();
            String input = o.get("input").isJsonNull() ? null : o.get("input").toString();
            boolean ok = o.get("ok").getAsBoolean();
            List<String> anchors = new ArrayList<>();
            if (o.has("errContains")) {
                for (var a : o.getAsJsonArray("errContains")) {
                    anchors.add(a.getAsString());
                }
            }
            cases.add(new Case(o.get("id").getAsString(), input, ok, anchors));
        }
        return cases;
    }

    @Test
    void sharedFixturesSameVerdictAsFrontend() throws Exception {
        List<Case> cases = loadCases();
        assertTrue(cases.size() >= 15, "共享样本至少 15 条: " + cases.size());
        for (Case c : cases) {
            String errs = AppService.themeErrors(c.inputJson());
            boolean accepted = errs.isEmpty();
            assertEquals(c.ok(), accepted,
                    "[" + c.id() + "] 判定漂移: input=" + c.inputJson() + " errs=" + errs);
            if (!c.ok()) {
                for (String anchor : c.errContains()) {
                    assertTrue(errs.contains(anchor),
                            "[" + c.id() + "] 错误锚点缺失: " + anchor + " in " + errs);
                }
            }
        }
    }

    /** JSON 形态整体拒绝（数组/字符串/坏 JSON）——与前端「数组/字符串形态整体拒绝」同判。 */
    @Test
    void nonObjectShapesRejected() {
        assertEquals(false, AppService.themeErrors("[1,2]").isEmpty());
        assertEquals(false, AppService.themeErrors("\"blue\"").isEmpty());
        assertEquals(false, AppService.themeErrors("not-json{").isEmpty());
        assertEquals(true, AppService.themeErrors(null).isEmpty());
        assertEquals(true, AppService.themeErrors("").isEmpty());
        assertEquals(true, AppService.themeErrors("null").isEmpty());
    }

    /** 便捷：供其他测试读取共享样本（InputStream 形态预留 Maven testResources 接入）。 */
    static InputStream fixtureStream() {
        return ThemeVectorTest.class.getResourceAsStream("/theme-fixtures.json");
    }
}
