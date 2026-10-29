package com.schema.protocol.expr;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.junit.jupiter.api.Test;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.google.gson.reflect.TypeToken;

/**
 * M1.5 expr-test-vectors 双端执行器（后端 JUnit 侧）。
 *
 * 向量真源：schema-frontend/packages/schema-protocol/contract/expr-test-vectors.json
 * 与前端 Vitest 执行器（test/vectors.test.ts）跑同一份文件——
 * 逐条断言结果值 / 错误码一致；「一边抛异常一边返回默认值」即 FAIL（01 篇 §5.2 执行器契约）。
 */
class ExprVectorTest {

    private static final Path VECTORS = Paths.get("..", "..", "schema-frontend", "packages", "schema-protocol",
            "contract", "expr-test-vectors.json");

    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

    private record Vector(String id, String category, String source, Map<String, Object> scope, String clock,
                          JsonObject expect) {
    }

    private static List<Vector> loadVectors() throws Exception {
        if (!Files.exists(VECTORS)) {
            throw new IllegalStateException("向量文件缺失: " + VECTORS.toAbsolutePath());
        }
        List<Vector> out = new ArrayList<>();
        try (Reader reader = Files.newBufferedReader(VECTORS, StandardCharsets.UTF_8)) {
            JsonArray arr = JsonParser.parseReader(reader).getAsJsonArray();
            for (JsonElement el : arr) {
                JsonObject o = el.getAsJsonObject();
                Map<String, Object> scope = new HashMap<>();
                if (o.has("scope") && o.get("scope").isJsonObject()) {
                    for (Map.Entry<String, JsonElement> e : o.getAsJsonObject("scope").entrySet()) {
                        scope.put(e.getKey(), fromJson(e.getValue()));
                    }
                }
                out.add(new Vector(
                        o.get("id").getAsString(),
                        o.get("category").getAsString(),
                        o.get("source").getAsString(),
                        scope,
                        o.has("clock") && !o.get("clock").isJsonNull() ? o.get("clock").getAsString() : null,
                        o.getAsJsonObject("expect")));
            }
        }
        return out;
    }

    private static Object fromJson(JsonElement el) {
        if (el.isJsonNull()) {
            return null;
        }
        if (el.isJsonPrimitive()) {
            JsonPrimitive p = el.getAsJsonPrimitive();
            if (p.isBoolean()) {
                return p.getAsBoolean();
            }
            if (p.isNumber()) {
                double d = p.getAsDouble();
                return d == Math.floor(d) && !Double.isInfinite(d) ? (Object) p.getAsDouble() : (Object) p.getAsDouble();
            }
            return p.getAsString();
        }
        if (el.isJsonArray()) {
            List<Object> list = new ArrayList<>();
            for (JsonElement e : el.getAsJsonArray()) {
                list.add(fromJson(e));
            }
            return list;
        }
        Map<String, Object> map = new HashMap<>();
        for (Map.Entry<String, JsonElement> e : el.getAsJsonObject().entrySet()) {
            map.put(e.getKey(), fromJson(e.getValue()));
        }
        return map;
    }

    /** 求值结果 → JSON 包装，期望值直接 JSON 树比对（规避 double/long 等装箱差异）。 */
    private static JsonElement toJson(Object v) {
        if (v == null) {
            return JsonNull.INSTANCE;
        }
        if (v instanceof Boolean b) {
            return new JsonPrimitive(b);
        }
        if (v instanceof Number n) {
            double d = n.doubleValue();
            if (d == Math.rint(d) && !Double.isInfinite(d) && Math.abs(d) < 1e15) {
                return new JsonPrimitive((long) d);
            }
            return new JsonPrimitive(d);
        }
        if (v instanceof Instant i) {
            return new JsonPrimitive(i.toString());
        }
        if (v instanceof List<?> list) {
            JsonArray arr = new JsonArray();
            for (Object e : list) {
                arr.add(toJson(e));
            }
            return arr;
        }
        return new JsonPrimitive(String.valueOf(v));
    }

    private static String runVector(Vector v) {
        ExprEngine.Node ast;
        try {
            ast = ExprEngine.compile(v.source());
        } catch (ExprEngine.CompileException e) {
            return "CompileError:" + e.error.message();
        }
        Instant clock = v.clock() != null ? Instant.parse(v.clock()) : null;
        ExprEngine.EvalResult result = ExprEngine.evaluate(ast, v.scope(), clock);
        if (result.error() != null) {
            return "error:" + result.error().code();
        }
        return "value:" + GSON.toJson(toJson(result.value()));
    }

    @Test
    void allVectorsMatchExpectedSemantics() throws Exception {
        List<Vector> vectors = loadVectors();
        assertTrue(vectors.size() >= 20, "向量应不少于 20 条，当前 " + vectors.size());

        Set<String> categories = new HashSet<>();
        List<String> failures = new ArrayList<>();
        for (Vector v : vectors) {
            categories.add(v.category());
            String actual = runVector(v);
            JsonObject expect = v.expect();
            String expected;
            if (expect.has("value")) {
                JsonElement ev = expect.get("value");
                if (ev.isJsonNull() || (ev.isJsonPrimitive() && !ev.getAsJsonPrimitive().isNumber())) {
                    expected = "value:" + GSON.toJson(ev);
                } else if (ev.isJsonPrimitive() && ev.getAsJsonPrimitive().isNumber()) {
                    double d = ev.getAsDouble();
                    JsonElement normalized = (d == Math.rint(d) && !Double.isInfinite(d) && Math.abs(d) < 1e15)
                            ? new JsonPrimitive((long) d)
                            : new JsonPrimitive(d);
                    expected = "value:" + GSON.toJson(normalized);
                } else {
                    expected = "value:" + GSON.toJson(ev);
                }
            } else {
                expected = "error:" + expect.get("error").getAsString();
            }
            if (!actual.equals(expected)) {
                failures.add(String.format("[%s] %s%n  expect %s%n  actual %s", v.id(), v.source(), expected, actual));
            }
        }
        assertTrue(failures.isEmpty(), "向量执行不一致 " + failures.size() + " 条:%n" + String.join("%n", failures));

        for (String required : List.of("日期时区", "空值传播", "数值精度", "短路求值", "类型转换")) {
            assertTrue(categories.contains(required), "缺少分类 " + required);
        }
    }

    @Test
    void budgetAbortsRunawayNesting() {
        String src = "1" + " + 1".repeat(1200);
        ExprEngine.Node ast = ExprEngine.compile(src);
        ExprEngine.EvalResult r = ExprEngine.evaluate(ast, Map.of());
        assertNotNull(r.error());
        assertEquals("EvalBudgetError", r.error().code());
    }

    @Test
    void compileRejectsAssignmentArrowAndNonWhitelistCall() {
        for (String bad : List.of("a = 1", "items.map(x => x * 2)", "order.toFixed(2)", "eval('1+1')", "a;b")) {
            assertThrows(ExprEngine.CompileException.class, () -> ExprEngine.compile(bad), "应拒绝: " + bad);
        }
    }

    @Test
    void whitelistMatchesFunctionsContract() throws Exception {
        Path functions = Paths.get("..", "..", "schema-frontend", "packages", "schema-protocol", "contract", "functions.json");
        try (Reader reader = Files.newBufferedReader(functions, StandardCharsets.UTF_8)) {
            List<Map<String, Object>> contract = new Gson().fromJson(reader,
                    new TypeToken<List<Map<String, Object>>>() {}.getType());
            List<String> expected = contract.stream().map(m -> String.valueOf(m.get("name"))).sorted().toList();
            List<String> actual = ExprEngine.FUNCTION_NAMES.stream().sorted().toList();
            assertArrayEquals(expected.toArray(), actual.toArray(), "白名单与 functions.json 漂移");
        }
    }

    @Test
    void missingScopeKeyYieldsFieldMissing() {
        ExprEngine.Node ast = ExprEngine.compile("notExist");
        ExprEngine.EvalResult r = ExprEngine.evaluate(ast, Map.of());
        assertNotNull(r.error());
        assertEquals("FieldMissingError", r.error().code());
        assertNull(r.value());
    }
}
