package com.schema.build;

import com.schema.build.infrastructure.node.NodeBuildWorker;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.schema.platform.common.json.Json;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * 红线双端同判门禁（08FE §8 / redline-vectors.json 唯一真源）：
 * 后端 Node 工脚本（保存期第二道闸的服务端实现）对共享向量逐条执行，
 * 期望判定与前端 Vitest 同一份文件——漂移即 FAIL。
 *
 * 运行条件：Node 可执行 + 仓库 build-module/node 布局（CI 与本地默认满足）。
 */
class RedlineVectorTest {

    private static NodeBuildWorker worker;
    private static List<Map<String, Object>> vectors;
    private static Path vectorsPath;

    @BeforeAll
    static void setup() throws Exception {
        // 仓库布局探测（与 NodeBuildWorker.resolveWorkerDir 同序）；surefire 工作目录 = 模块根
        Path workerDir = null;
        for (String candidate : new String[] {
                "node", "build-module/node", "schema-platform/build-module/node"}) {
            Path p = Path.of(candidate).toAbsolutePath().normalize();
            if (Files.exists(p.resolve("build-worker.mjs"))) {
                workerDir = p;
                break;
            }
        }
        assertNotNull(workerDir, "build-worker 目录未找到（需在仓库根或 schema-platform 下运行）");
        worker = new NodeBuildWorker("node", workerDir.toString(), 10_000);

        vectorsPath = workerDir.resolve("redline-vectors.json");
        if (!Files.exists(vectorsPath)) {
            // 后端 resources 内副本（打包态）
            vectorsPath = Path.of("src/main/resources/contract/redline-vectors.json");
        }
        JsonObject root = JsonParser.parseString(Files.readString(vectorsPath)).getAsJsonObject();
        assertEquals(1, root.get("formatVersion").getAsInt(), "向量文件 formatVersion 必须=1");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> parsed = (List<Map<String, Object>>) (List<?>) Json.readList(root.get("vectors").toString());
        vectors = parsed;
    }

    @Test
    void vectorsSameVerdictAsFrontend() {
        assertTrue(vectors.size() >= 20, "共享向量至少 20 条（当前 " + vectors.size() + "）");
        int allowed = 0;
        int blocked = 0;
        for (Map<String, Object> v : vectors) {
            String id = String.valueOf(v.get("id"));
            String source = String.valueOf(v.get("source"));
            boolean expectAllowed = Boolean.TRUE.equals(v.get("allowed"));
            String expectRule = v.get("rule") == null ? null : String.valueOf(v.get("rule"));

            var result = worker.compile(source);
            if (expectAllowed) {
                allowed++;
                // 期望放行：必须成功且产出 contentHash（编译链路闭环）
                assertTrue(result.success(), "向量 " + id + " 期望放行，实际被拒: "
                        + Json.write(result.errors()));
                assertNotNull(result.contentHash(), "向量 " + id + " 放行但缺 contentHash");
            } else {
                blocked++;
                // 期望拒绝：必须失败；rule 命中判定与前端同判口径——
                // with 在 ESM 严格模式下语法层不可解析 → SYNTAX_ERROR 即拦截（拦截目标天然达成）
                assertTrue(!result.success(), "向量 " + id + " 期望拒绝，实际放行");
                assertNotNull(result.errors(), "向量 " + id + " 拒绝但无错误明细");
                boolean syntaxFallback = "WITH_STMT".equals(expectRule) && result.errors().stream()
                        .anyMatch(e -> "SYNTAX_ERROR".equals(e.code()));
                boolean hit = result.errors().stream()
                        .anyMatch(e -> expectRule != null && expectRule.equals(e.code()));
                assertTrue(hit || syntaxFallback, "向量 " + id + " 拒绝但未命中期望 rule " + expectRule
                        + "（实际: " + Json.write(result.errors()) + "）");
            }
        }
        System.out.println("redline vectors: " + vectors.size() + " 条同判一致（allowed=" + allowed
                + ", blocked=" + blocked + "）");
    }

    @Test
    void securityBlockedStatusClassification() {
        // GLOBAL_DOM 命中必须归类 SECURITY_BLOCKED 而非 FAILED（04BE §2.4 状态机）
        var r = worker.compile("export function onLoad(ctx) { window.alert(1); }");
        assertTrue(!r.success());
        assertTrue(r.errors().stream().anyMatch(e -> "GLOBAL_DOM".equals(e.code())));
    }

    @Test
    void syntaxErrorIsCompileFailureNotSecurity() {
        // 语法错误是 CompileError（非安全违规）——但仍拒绝编译（08FE §3）；code=SYNTAX_ERROR
        var r = worker.compile("export function onLoad(ctx { return 1; }");
        assertTrue(!r.success());
        assertTrue(r.errors().stream().anyMatch(e -> "SYNTAX_ERROR".equals(e.code())));
    }

    @Test
    void nonReadingProcessCannotBlockInputBeyondDeadline(@org.junit.jupiter.api.io.TempDir Path dir) throws Exception {
        Files.writeString(dir.resolve("build-worker.mjs"), "setInterval(() => {}, 1000);");
        Files.writeString(dir.resolve("redlines.json"), "{}");
        var stalled = new NodeBuildWorker("node", dir.toString(), 500);
        var result = org.junit.jupiter.api.Assertions.assertTimeoutPreemptively(
                java.time.Duration.ofSeconds(5), () -> stalled.compile("x".repeat(2_000_000)));
        assertTrue(!result.success());
        assertTrue(result.errors().stream().anyMatch(e -> "BUILD_TIMEOUT".equals(e.code())));
    }

    @Test
    void largeStdoutAndStderrAreFullyDrained(@org.junit.jupiter.api.io.TempDir Path dir) throws Exception {
        Files.writeString(dir.resolve("build-worker.mjs"), """
                process.stdin.resume();
                process.stdin.on('end', () => {
                  process.stderr.write('e'.repeat(200000));
                  process.stdout.write(JSON.stringify({ok:false, errors:[{message:'m'.repeat(200000), code:'DRAIN_TEST'}]}));
                });
                """);
        Files.writeString(dir.resolve("redlines.json"), "{}");
        var draining = new NodeBuildWorker("node", dir.toString(), 5000);
        var result = draining.compile("test");
        assertTrue(!result.success());
        assertTrue(result.errors().stream().anyMatch(e -> "DRAIN_TEST".equals(e.code())));
    }

    @Test
    void artifactImmutableByHash() {
        // 同源码两次编译 contentHash 一致（产物不可变——04BE §2.3④）
        var src = "export function onLoad(ctx) { return ctx.page.params; }";
        var r1 = worker.compile(src);
        var r2 = worker.compile(src);
        assertTrue(r1.success() && r2.success());
        assertEquals(r1.contentHash(), r2.contentHash());
    }
}
