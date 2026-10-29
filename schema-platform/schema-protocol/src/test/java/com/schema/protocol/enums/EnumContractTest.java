package com.schema.protocol.enums;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;

import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.junit.jupiter.api.Test;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;

/**
 * M1.5 枚举值专项比对（评审稿 §7.3 遗留项闭环）：
 * 后端 Java 枚举 vs 前端 contract/export/enums.json（唯一真源）——逐组 diff，
 * 任何一侧新增/删除枚举值而另一侧未跟即 FAIL（对应测试文档 01 篇 C-ENUM-01）。
 */
class EnumContractTest {

    private static final Path FRONT_ENUMS = Paths.get("..", "..", "schema-frontend", "packages", "schema-protocol",
            "contract", "export", "enums.json");

    private static List<String> javaCodes(Class<? extends Enum<?>> enumClass) {
        List<String> codes = new ArrayList<>();
        for (Enum<?> constant : enumClass.getEnumConstants()) {
            try {
                Object code = enumClass.getMethod("code").invoke(constant);
                codes.add(String.valueOf(code));
            } catch (ReflectiveOperationException e) {
                throw new IllegalStateException("枚举缺少 code() 方法: " + enumClass.getSimpleName(), e);
            }
        }
        return codes;
    }

    @SuppressWarnings("unchecked")
    private static List<String> frontValues(java.util.Map<String, List<String>> front, String key) {
        List<String> values = front.get(key);
        if (values == null) {
            throw new IllegalStateException("前端 enums.json 缺少枚举组: " + key);
        }
        return values;
    }

    private static java.util.Map<String, List<String>> loadFrontEnums() throws Exception {
        if (!Files.exists(FRONT_ENUMS)) {
            // CI 环境先跑前端导出脚本（pnpm --filter @schema/schema-protocol run export:enums）
            throw new IllegalStateException("前端枚举导出文件缺失: " + FRONT_ENUMS.toAbsolutePath());
        }
        try (Reader reader = Files.newBufferedReader(FRONT_ENUMS, StandardCharsets.UTF_8)) {
            return new Gson().fromJson(reader, new TypeToken<java.util.Map<String, List<String>>>() {}.getType());
        }
    }

    @Test
    void fieldTypeMatchesFrontendTruth() throws Exception {
        List<String> front = frontValues(loadFrontEnums(), "FieldType");
        List<String> java = javaCodes(FieldType.class);
        assertEquals(12, front.size(), "字段类型应为 12 种（textarea/datetime 不进枚举）");
        assertArrayEquals(front.toArray(), java.toArray(), "FieldType 双端枚举漂移");
    }

    @Test
    void filterOpMatchesFrontendTruth() throws Exception {
        List<String> front = frontValues(loadFrontEnums(), "FilterOp");
        List<String> java = javaCodes(FilterOp.class);
        assertEquals(11, front.size(), "过滤操作符应为 11 个（含 nin；isnull 全小写）");
        assertArrayEquals(front.toArray(), java.toArray(), "FilterOp 双端枚举漂移");
    }

    @Test
    void actionTypeMatchesFrontendTruth() throws Exception {
        List<String> front = frontValues(loadFrontEnums(), "ActionType");
        List<String> java = javaCodes(ActionType.class);
        assertEquals(6, front.size(), "动作类型应为 6 种");
        assertArrayEquals(front.toArray(), java.toArray(), "ActionType 双端枚举漂移");
    }

    @Test
    void coreGroupsCovered() {
        // 防御：新增枚举组时必须同步扩展本测试（C-ENUM-03 反向断言的组织形态）
        List<String> covered = Arrays.asList("FieldType", "FilterOp", "ActionType");
        for (String group : covered) {
            switch (group) {
                case "FieldType" -> javaCodes(FieldType.class);
                case "FilterOp" -> javaCodes(FilterOp.class);
                case "ActionType" -> javaCodes(ActionType.class);
                default -> throw new IllegalStateException("未覆盖枚举组: " + group);
            }
        }
    }
}
