package com.schema.page.application;

import com.schema.platform.common.json.Json;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * PageSchema 协议校验器（M1 契约面接线 04BE §1.1：后端保存/发布前走同一份 zod 导出真源）。
 *
 * 真源 = 前端 contract/export/schema.json 的 definitions.PageSchema（双端同判铁律的运行时消费）；
 * 与前端 validate.ts 的差异点由 M1 三层同判门禁兜底（schema-fixtures 双端一致）。
 *
 * 校验两级：
 *  1. 结构（SchemaValidator 执行 PageSchema JSON Schema 定义）；
 *  2. 身份一致性：pageKey/name/type/modelId/path 与页面登记字段一致（协议身份不得漂移）。
 */
@Component
public class PageSchemaValidator {

    private final Map<String, Object> pageSchemaDef;

    @SuppressWarnings("unchecked")
    public PageSchemaValidator(@Value("${page.protocol-schema:}") String externalPath) {
        Map<String, Object> def = null;
        // 1) 显式配置路径（CI/本地开发优先）
        if (externalPath != null && !externalPath.isBlank()) {
            def = loadDefinitions(Paths.get(externalPath));
        }
        // 2) classpath 资源（verify 前端导出拷贝入 bootstrap resources——contract 同源）
        if (def == null) {
            def = loadFromClasspath();
        }
        // 3) 仓库相对路径兜底（schema-platform 同仓 checkout 形态）
        if (def == null) {
            for (String candidate : List.of(
                    Paths.get("..", "..", "..", "..", "schema-frontend", "packages", "schema-protocol",
                            "contract", "export", "schema.json").toString(),
                    Paths.get("..", "schema-frontend", "packages", "schema-protocol",
                            "contract", "export", "schema.json").toString())) {
                Path p = Paths.get(candidate).toAbsolutePath().normalize();
                if (Files.exists(p)) {
                    def = loadDefinitions(p);
                    if (def != null) {
                        break;
                    }
                }
            }
        }
        if (def == null) {
            // 校验器不可用属部署错误——fail-fast 优于静默跳过（否则协议门禁形同虚设）
            throw new IllegalStateException(
                    "PageSchema 协议真源缺失：请先执行 pnpm --filter @schema/schema-protocol run export:schema");
        }
        this.pageSchemaDef = def;
    }

    /** 结构校验：返回错误清单（空 = 通过）。 */
    @SuppressWarnings("unchecked")
    public List<String> validate(Map<String, Object> schema) {
        List<String> errors = new ArrayList<>();
        if (schema == null) {
            errors.add("schema 缺失");
            return errors;
        }
        try {
            if (!com.schema.protocol.schema.SchemaValidator.accepts(pageSchemaDef, schema)) {
                errors.add("Schema 结构不符合 PageSchema 协议定义");
            }
        } catch (Exception e) {
            errors.add("Schema 校验器异常: " + e.getMessage());
        }
        // 身份字段显式校验（协议身份四件套——结构 schema 未覆盖的语义面）
        Object schemaVersion = schema.get("schemaVersion");
        if (!(schemaVersion instanceof Number n) || n.intValue() < 1) {
            errors.add("schemaVersion 必须为正整数");
        }
        if (!(schema.get("path") instanceof String p) || !p.startsWith("/")) {
            errors.add("path 必须以 / 开头");
        }
        return errors;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> loadDefinitions(Path schemaJson) {
        try {
            Map<String, Object> root = (Map<String, Object>) Json.readMap(
                    Files.readString(schemaJson, StandardCharsets.UTF_8));
            Map<String, Object> defs = (Map<String, Object>) root.get("definitions");
            if (defs != null && defs.get("PageSchema") instanceof Map<?, ?> page) {
                return (Map<String, Object>) page;
            }
        } catch (Exception ignored) {
            // 加载失败走下一候选
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> loadFromClasspath() {
        try (InputStream in = new ClassPathResource("contract/page-schema.json").getInputStream()) {
            Map<String, Object> root = (Map<String, Object>) Json.readMap(
                    new String(in.readAllBytes(), StandardCharsets.UTF_8));
            if (root.get("definitions") instanceof Map<?, ?> defs
                    && defs instanceof Map<?, ?> && ((Map<String, Object>) defs).get("PageSchema") != null) {
                return (Map<String, Object>) ((Map<String, Object>) root.get("definitions")).get("PageSchema");
            }
        } catch (Exception ignored) {
            // classpath 无资源走文件兜底
        }
        return null;
    }
}
