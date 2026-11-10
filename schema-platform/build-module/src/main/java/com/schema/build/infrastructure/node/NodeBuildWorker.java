package com.schema.build.infrastructure.node;

import com.schema.build.domain.BuildTask;
import com.schema.build.domain.CodeBuildService;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.schema.platform.common.json.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Node 编译工进程调度（04BE §2.1：Java 进程绝不运行 JS 工具链）。
 * 每次编译起独立 Node 进程执行 build-worker.mjs（acorn 扫描 + esbuild 转换），
 * 协议 stdin/stdout 各一段 JSON；进程崩溃/超时按编译失败处理（绝不静默放行）。
 */
@Component
public class NodeBuildWorker {

    private static final Logger log = LoggerFactory.getLogger(NodeBuildWorker.class);

    private final String nodeCommand;
    private final Path workerScript;
    private final Path redlinesPath;
    private final long timeoutMs;

    /**
     * worker 目录解析顺序（依赖可达性是硬约束——acorn/esbuild 必须在脚本可达的 node_modules）：
     * ① build.worker-dir 显式配置（部署态）
     * ② 仓库布局 build-module/node（开发态——依赖随 package.json 安装在该目录）
     * ③ JAR 内资源解包（依赖不可达时编译返回 WORKER_UNAVAILABLE，不静默放行）
     */
    public NodeBuildWorker(
            @Value("${build.node-command:node}") String nodeCommand,
            @Value("${build.worker-dir:}") String workerDir,
            @Value("${build.timeout-ms:10000}") long timeoutMs) throws Exception {
        this.nodeCommand = nodeCommand;
        this.timeoutMs = timeoutMs;
        Path dir = resolveWorkerDir(workerDir);
        Path script = dir.resolve("build-worker.mjs");
        if (Files.exists(script)) {
            this.workerScript = script;
            this.redlinesPath = ensureRedlines(dir);
        } else {
            // JAR 内资源兜底：脚本解包临时目录；红线真源取资源内副本。
            // 目录缺失不抛异常（bean 必须可创建）——运行期首个请求以 WORKER_UNAVAILABLE 明确报错
            this.workerScript = extractResource("/node/build-worker.mjs");
            Path fallbackDir = dir;
            Files.createDirectories(fallbackDir);
            this.redlinesPath = ensureRedlines(fallbackDir);
        }
    }

    /** 红线真源定位：worker 目录优先（与前端真源同步），缺失则从类路径资源解包。 */
    private static Path ensureRedlines(Path dir) throws Exception {
        Path local = dir.resolve("redlines.json");
        if (Files.exists(local)) return local;
        Files.createDirectories(dir);
        try (InputStream in = NodeBuildWorker.class.getResourceAsStream("/contract/redlines.json")) {
            if (in == null) {
                throw new IllegalStateException("红线真源缺失: /contract/redlines.json");
            }
            Files.copy(in, local, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
        return local;
    }

    private static Path resolveWorkerDir(String configured) {
        if (configured != null && !configured.isBlank()) {
            return Path.of(configured).toAbsolutePath().normalize();
        }
        // 开发态默认：仓库 build-module/node（相对工作目录探测两级布局）
        for (String candidate : new String[] {
                "schema-platform/build-module/node", "build-module/node", "node"}) {
            Path p = Path.of(candidate).toAbsolutePath().normalize();
            if (Files.exists(p.resolve("build-worker.mjs"))) {
                return p;
            }
        }
        return Path.of("build-worker").toAbsolutePath().normalize();
    }

    /** 执行编译；任何异常都收敛为 FAILED 结果（不抛出——调用方只看协议结果）。 */
    public BuildTask.Result compile(String sourceCode) {
        Process proc = null;
        try {
            ProcessBuilder pb = new ProcessBuilder(nodeCommand, workerScript.toString())
                    .redirectErrorStream(false);
            proc = pb.start();
            String request = Json.write(new Request(sourceCode, redlinesPath.toString()));
            proc.getOutputStream().write(request.getBytes(StandardCharsets.UTF_8));
            proc.getOutputStream().close();

            // stderr 并发排空（防管道缓冲区满导致子进程写阻塞——同步 readAllBytes 会先卡死）
            final Process p = proc;
            CompletableFuture<String> stderr = CompletableFuture.supplyAsync(() -> {
                try (InputStream err = p.getErrorStream()) {
                    return new String(err.readAllBytes(), StandardCharsets.UTF_8);
                } catch (Exception e) {
                    return "";
                }
            });
            // stdout 缓冲读（限时 waitFor 之后再取内容——waitFor 不依赖流消费即可推进）
            ByteArrayOutputStream stdoutBuf = new ByteArrayOutputStream();
            CompletableFuture<Void> stdoutDrain = CompletableFuture.runAsync(() -> {
                try (InputStream in = p.getInputStream()) {
                    in.transferTo(stdoutBuf);
                } catch (Exception ignored) {
                    // 进程被强制终止时流关闭属正常——内容以 waitFor 后缓冲为准
                }
            });

            boolean finished = proc.waitFor(timeoutMs, TimeUnit.MILLISECONDS);
            if (!finished) {
                proc.destroyForcibly().waitFor(2, TimeUnit.SECONDS);
                return new BuildTask.Result(false, null,
                        List.of(new BuildTask.CompileError(null, null,
                                "编译超时 %dms（已终止）".formatted(timeoutMs), "BUILD_TIMEOUT")), (int) timeoutMs);
            }
            if (proc.exitValue() != 0) {
                String errText = stderr.getNow("");
                return new BuildTask.Result(false, null,
                        List.of(new BuildTask.CompileError(null, null,
                                "编译进程异常退出 code=%d%s".formatted(proc.exitValue(),
                                        errText.isBlank() ? "" : "：" + errText.trim()), "WORKER_CRASH")), 0);
            }
            String stdout = stdoutBuf.toString(StandardCharsets.UTF_8);
            return parseResponse(stdout);
        } catch (Exception e) {
            log.warn("build-worker 调度失败: {}", e.getMessage());
            return new BuildTask.Result(false, null,
                    List.of(new BuildTask.CompileError(null, null,
                            "编译服务不可用: " + e.getMessage(), "WORKER_UNAVAILABLE")), 0);
        } finally {
            if (proc != null && proc.isAlive()) {
                proc.destroyForcibly();
            }
        }
    }

    private BuildTask.Result parseResponse(String stdout) {
        if (stdout == null || stdout.isBlank()) {
            return new BuildTask.Result(false, null,
                    List.of(new BuildTask.CompileError(null, null, "编译进程无输出", "WORKER_CRASH")), 0);
        }
        JsonObject resp;
        try {
            resp = JsonParser.parseString(stdout.trim()).getAsJsonObject();
        } catch (Exception e) {
            return new BuildTask.Result(false, null,
                    List.of(new BuildTask.CompileError(null, null,
                            "编译进程输出非法: " + e.getMessage(), "WORKER_CRASH")), 0);
        }
        List<BuildTask.CompileError> errors = new ArrayList<>();
        if (resp.has("errors") && resp.get("errors").isJsonArray()) {
            JsonArray arr = resp.getAsJsonArray("errors");
            for (var el : arr) {
                JsonObject o = el.getAsJsonObject();
                errors.add(new BuildTask.CompileError(
                        o.has("line") && !o.get("line").isJsonNull() ? o.get("line").getAsInt() : null,
                        o.has("column") && !o.get("column").isJsonNull() ? o.get("column").getAsInt() : null,
                        o.has("message") ? o.get("message").getAsString() : "未知错误",
                        o.has("code") && !o.get("code").isJsonNull() ? o.get("code").getAsString() : null));
            }
        }
        boolean ok = resp.has("ok") && resp.get("ok").getAsBoolean();
        String contentHash = ok && resp.has("contentHash") ? resp.get("contentHash").getAsString() : null;
        String artifact = ok && resp.has("artifact") && !resp.get("artifact").isJsonNull()
                ? resp.get("artifact").getAsString() : null;
        return new BuildTask.Result(ok, contentHash, artifact, errors, 0);
    }

    /** 类路径资源解包到临时目录（Node 进程无法读 JAR 内资源）。 */
    private static Path extractResource(String resource) throws Exception {
        Path tmp = Files.createTempFile("schema-build", "-" + resource.substring(resource.lastIndexOf('/') + 1));
        tmp.toFile().deleteOnExit();
        try (InputStream in = NodeBuildWorker.class.getResourceAsStream(resource)) {
            if (in == null) {
                throw new IllegalStateException("build-worker 资源缺失: " + resource);
            }
            Files.copy(in, tmp, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
        return tmp;
    }

    private record Request(String sourceCode, String redlinesPath) {
    }

    /** 时长语义占位（外部按需消费；默认 10s 对齐 04BE §2.3 构建时长上限）。 */
    public Duration configuredTimeout() {
        return Duration.ofMillis(timeoutMs);
    }
}
