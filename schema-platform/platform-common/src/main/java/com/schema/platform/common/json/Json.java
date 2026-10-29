package com.schema.platform.common.json;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.reflect.TypeToken;

import java.util.List;
import java.util.Map;

/**
 * JSON 横切工具（platform-common）：统一 Gson 实例。
 * 序列化 null 字段保留（JSONB 列可写 null）；未知字段宽容（Jackson 宽松校验口径 ADR-013）。
 */
public final class Json {

    private static final Gson GSON = new GsonBuilder().serializeNulls().create();
    private static final Gson PRETTY = new GsonBuilder().serializeNulls().setPrettyPrinting().create();

    private Json() {
    }

    public static String write(Object value) {
        return GSON.toJson(value);
    }

    public static String pretty(Object value) {
        return PRETTY.toJson(value);
    }

    public static <T> T read(String json, Class<T> type) {
        return GSON.fromJson(json, type);
    }

    public static Map<String, Object> readMap(String json) {
        if (json == null || json.isBlank() || "null".equals(json)) {
            return null;
        }
        return GSON.fromJson(json, new TypeToken<Map<String, Object>>() {
        }.getType());
    }

    public static List<Object> readList(String json) {
        if (json == null || json.isBlank() || "null".equals(json)) {
            return null;
        }
        return GSON.fromJson(json, new TypeToken<List<Object>>() {
        }.getType());
    }

    public static JsonObject parseObject(String json) {
        return JsonParser.parseString(json).getAsJsonObject();
    }

    public static JsonElement parse(String json) {
        return JsonParser.parseString(json);
    }

    public static JsonObject obj() {
        return new JsonObject();
    }

    public static JsonArray array() {
        return new JsonArray();
    }

    /** 深度比较两个 JSON 字符串语义是否一致（用于快照 diff 等）。 */
    public static boolean sameJson(String a, String b) {
        if (a == null || b == null) {
            return a == null && b == null;
        }
        return parse(a).equals(parse(b));
    }
}
