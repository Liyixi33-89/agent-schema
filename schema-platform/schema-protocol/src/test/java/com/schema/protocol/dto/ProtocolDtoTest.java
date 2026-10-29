package com.schema.protocol.dto;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.schema.protocol.enums.FieldType;
import com.schema.protocol.schema.SchemaValidator;

/**
 * M1.4 DTO 镜像映射测试：共享样本 JSON → ProtocolDtos record 往返无损。
 *
 * 验证三点：
 *  1. 合法样本经 Gson 映射到 record 后关键字段语义完整（枚举/嵌套/过滤树形态）；
 *  2. 映射产物字段结构与前端 types.ts 同源（抽样断言，非全量镜像比对）；
 *  3. 序列化回 JSON 仍通过 SchemaValidator——DTO 表示不引入结构漂移。
 */
class ProtocolDtoTest {

    private static final Path FIXTURES = Paths.get("..", "..", "schema-frontend", "packages", "schema-protocol",
            "contract", "schema-fixtures.json");

    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping()
            .registerTypeAdapter(FieldType.class, (com.google.gson.JsonSerializer<FieldType>) (src, type, ctx) ->
                    ctx.serialize(src.code()))
            .registerTypeAdapter(FieldType.class, (com.google.gson.JsonDeserializer<FieldType>) (json, type, ctx) -> {
                String code = json.getAsString();
                for (FieldType ft : FieldType.values()) {
                    if (ft.code().equals(code)) return ft;
                }
                throw new IllegalArgumentException("未知字段类型: " + code);
            })
            .create();

    @Test
    void modelFixtureMapsToRecordWithSemantics() throws Exception {
        JsonArray fixtures = JsonParser.parseString(Files.readString(FIXTURES, StandardCharsets.UTF_8)).getAsJsonArray();
        JsonObject modelValid = fixtures.asList().stream()
                .map(e -> e.getAsJsonObject())
                .filter(o -> "model-valid".equals(o.get("name").getAsString()))
                .findFirst().orElseThrow();
        ProtocolDtos.ModelSchema model = GSON.fromJson(modelValid.get("input"), ProtocolDtos.ModelSchema.class);
        assertEquals("m1", model.id());
        assertEquals(1, model.fields().size());
        assertEquals(FieldType.NUMBER, model.fields().get(0).type(), "字段类型枚举应映射为 FieldType");
        assertEquals("ACTIVE", model.fields().get(0).fieldStatus());
        // 往返：映射产物序列化回 JSON 再过 SchemaValidator，表示层不引入漂移
        Map<?, ?> exportRoot = GSON.fromJson(
                Files.readString(FIXTURES.getParent().resolve("export/schema.json"), StandardCharsets.UTF_8),
                Map.class);
        @SuppressWarnings("unchecked")
        Map<String, Object> exportDefs = (Map<String, Object>) exportRoot.get("definitions");
        Map<String, Object> modelSchemaDef = (Map<String, Object>) exportDefs.get("ModelSchema");
        assertTrue(SchemaValidator.accepts(modelSchemaDef, GSON.fromJson(GSON.toJson(model), Object.class)),
                "DTO 往返序列化应仍通过结构校验");
    }

    @Test
    void pageFixtureMapsFilterTreeAndAggregate() throws Exception {
        JsonArray fixtures = JsonParser.parseString(Files.readString(FIXTURES, StandardCharsets.UTF_8)).getAsJsonArray();
        JsonObject aggPage = fixtures.asList().stream()
                .map(e -> e.getAsJsonObject())
                .filter(o -> "agg-structure".equals(o.get("name").getAsString()))
                .findFirst().orElseThrow();
        ProtocolDtos.PageSchema page = GSON.fromJson(aggPage.get("input"), ProtocolDtos.PageSchema.class);
        assertEquals("DASHBOARD", page.type());
        assertEquals("MODEL_AGG", page.dataSource().type());
        assertEquals(1, page.dataSource().aggregate().measures().size());
        assertEquals("SUM", page.dataSource().aggregate().measures().get(0).func());
        assertEquals("MONTH", page.dataSource().aggregate().timeBucket().interval());
    }

    @Test
    void filterNodeSealedHierarchyCoversLeafAndCombinators() {
        // 过滤树三形态：叶子 + and + or（02BE §3.2 与前端 {and}/{or} 对应）
        ProtocolDtos.FilterNode leaf = new ProtocolDtos.LeafFilter("amount", "gte", 100);
        ProtocolDtos.FilterNode and = new ProtocolDtos.AndFilter(List.of(leaf));
        ProtocolDtos.FilterNode or = new ProtocolDtos.OrFilter(List.of(and));
        ProtocolDtos.LeafFilter lf = assertInstanceOf(ProtocolDtos.LeafFilter.class,
                assertInstanceOf(ProtocolDtos.AndFilter.class,
                        assertInstanceOf(ProtocolDtos.OrFilter.class, or).or().get(0)).and().get(0));
        assertEquals("amount", lf.field());
        assertEquals("gte", lf.op());
    }

    @Test
    void roundTripPreservesSchemaVersionAndKeys() throws Exception {
        JsonArray fixtures = JsonParser.parseString(Files.readString(FIXTURES, StandardCharsets.UTF_8)).getAsJsonArray();
        JsonObject minimal = fixtures.asList().stream()
                .map(e -> e.getAsJsonObject())
                .filter(o -> "minimal-valid".equals(o.get("name").getAsString()))
                .findFirst().orElseThrow();
        ProtocolDtos.PageSchema page = GSON.fromJson(minimal.get("input"), ProtocolDtos.PageSchema.class);
        assertEquals(1, page.schemaVersion());
        JsonObject back = JsonParser.parseString(GSON.toJson(page)).getAsJsonObject();
        assertEquals("LIST", back.get("type").getAsString());
        assertEquals("/x", back.get("path").getAsString());
        assertTrue(back.get("layout").isJsonArray());
        assertTrue(back.get("actions").isJsonArray());
    }
}
