package com.schema.protocol.schema;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.reflect.TypeToken;

/**
 * M1.5 结构 diff（契约 CI 三件套之二）：消费前端 contract/export/schema.json。
 *
 * 前端 zod → JSON Schema 导出为唯一真源；本测试锁定：
 *  1. 四组核心定义存在且顶层结构完整（$ref/definitions）；
 *  2. 关键枚举值集合嵌入在定义中（与 enums.json 交叉验证——结构 diff 的枚举盲区由枚举专项 diff 补齐）；
 *  3. fixture 判定表与前端双判结果一致（双端同判矩阵，测试文档 01 篇 §3.1 铁律的落地形态）。
 *
 * 完整的「后端加载 JSON Schema 做运行时校验」随 M2 页面服务保存链路落地（01BE）；
 * 本期锁结构与判定一致性，防双端 Schema 描述漂移。
 */
class SchemaContractTest {

    private static final Path SCHEMA_JSON = Paths.get("..", "..", "schema-frontend", "packages", "schema-protocol",
            "contract", "export", "schema.json");

    private static final Gson GSON = new Gson();

    private static JsonObject load() throws Exception {
        assertTrue(Files.exists(SCHEMA_JSON), "结构导出文件缺失: " + SCHEMA_JSON.toAbsolutePath()
                + "（先跑 pnpm --filter @schema/schema-protocol run export:schema）");
        try (Reader reader = Files.newBufferedReader(SCHEMA_JSON, StandardCharsets.UTF_8)) {
            return JsonParser.parseReader(reader).getAsJsonObject();
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void sharedFixturesAreActuallyValidated() throws Exception {
        Path fixturesPath = SCHEMA_JSON.getParent().getParent().resolve("schema-fixtures.json");
        List<Map<String, Object>> fixtures = GSON.fromJson(Files.readString(fixturesPath, StandardCharsets.UTF_8),
                new TypeToken<List<Map<String, Object>>>() {}.getType());
        JsonObject definitions = load().getAsJsonObject("definitions");
        for (Map<String, Object> fixture : fixtures) {
            Map<String, Object> schema = GSON.fromJson(definitions.get((String) fixture.get("schema")),
                    new TypeToken<Map<String, Object>>() {}.getType());
            assertEquals(fixture.get("valid"), SchemaValidator.accepts(schema, fixture.get("input")),
                    "双端判定不一致: " + fixture.get("name"));
        }
    }

    @Test
    void fourCoreDefinitionsExported() throws Exception {
        JsonObject root = load();
        assertEquals(1, root.get("schemaVersion").getAsInt(), "协议版本应为 1");
        JsonObject defs = root.getAsJsonObject("definitions");
        for (String name : List.of("ModelSchema", "FieldSchema", "LayoutNode", "FilterNode", "PageSchema", "DataSourceBinding", "ActionBinding", "ExpressionBinding")) {
            assertTrue(defs.has(name), "缺少定义 " + name);
            JsonObject def = defs.getAsJsonObject(name);
            assertTrue(def.has("$ref"), name + " 应为 $ref 包装结构");
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void pageTypeEnumMatchesContract() throws Exception {
        JsonObject root = load();
        JsonObject pageSchema = root.getAsJsonObject("definitions").getAsJsonObject("PageSchema")
                .getAsJsonObject("definitions").getAsJsonObject("PageSchema");
        JsonElement typeEnum = pageSchema.getAsJsonObject("properties").get("type").getAsJsonObject().get("enum");
        List<String> values = (List<String>) GSON.fromJson(typeEnum, new TypeToken<List<String>>() {}.getType());
        assertEquals(List.of("FORM", "LIST", "DETAIL", "DASHBOARD"), values, "PageSchema.type 枚举漂移");
    }

    @Test
    void paginationHardLimitAnchored() throws Exception {
        // 分页 size ≤ 200 是双端共享硬限（01FE §2 / 10BE §A.1）——锚定结构中的约束声明
        String raw = Files.readString(SCHEMA_JSON, StandardCharsets.UTF_8);
        assertTrue(raw.contains("\"maximum\": 200"), "pagination.size 上限 200 未出现在结构导出中");
        assertTrue(raw.contains("\"minimum\": 1"), "pagination.size 下限 1 未出现在结构导出中");
    }

    @Test
    @SuppressWarnings("unchecked")
    void fixtureVerdictsMatchFrontendDualVerdict() throws Exception {
        // 前端导出时已双判（zod + 运行时校验器）一致；此处锁定判定表本身防篡改回漂
        JsonObject root = load();
        Map<String, Boolean> verdicts = (Map<String, Boolean>) GSON.fromJson(root.get("fixtureVerdicts"),
                new TypeToken<Map<String, Boolean>>() {}.getType());
        assertNotNull(verdicts);
        assertEquals(6, verdicts.size(), "fixture 判定表应含 6 条");
        assertEquals(Boolean.TRUE, verdicts.get("minimal-valid"));
        assertEquals(Boolean.TRUE, verdicts.get("expr-prop"));
        assertEquals(Boolean.TRUE, verdicts.get("agg-structure"));
        assertEquals(Boolean.FALSE, verdicts.get("bad-action"));
        assertEquals(Boolean.FALSE, verdicts.get("oversize-pagination"));
        assertEquals(Boolean.FALSE, verdicts.get("bad-component-name"));
    }
}
