package com.schema.build.application;

import com.schema.build.domain.BuildTask;
import com.schema.build.domain.CodeBuildService;
import com.schema.build.infrastructure.node.NodeBuildWorker;
import com.schema.build.infrastructure.persistence.JdbcBuildTaskRepository;
import com.schema.build.infrastructure.storage.ArtifactStorage;
import com.schema.platform.common.json.Json;
import com.schema.platform.common.web.BizException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 编译流水线编排（04BE §2.3 五步的 P1 最小链路）：
 * 幂等前置 → Node 工进程（红线扫描① + esbuild② + 产物校验③）→ 产物上传④ → 结果落库⑤。
 *
 * 铁律：
 * - 编译失败不覆盖——contentHash 不回写，线上继续跑上一版（§2.3⑤）；
 * - 同源码幂等——命中既有 SUCCESS 直接复用产物，不产生新对象（§2.4）；
 * - 编译过程绝不执行客户代码。
 */
@Service
public class BuildCommandService implements CodeBuildService {

    private static final Logger log = LoggerFactory.getLogger(BuildCommandService.class);

    /** 单租户并发上限（04BE §2.4 配额；超限 429 BUILD_QUOTA_EXCEEDED）。 */
    static final int TENANT_CONCURRENCY_LIMIT = 2;

    private final NodeBuildWorker worker;
    private final JdbcBuildTaskRepository tasks;
    private final ArtifactStorage artifacts;
    private final BuildConcurrencyGuard guard;

    public BuildCommandService(NodeBuildWorker worker, JdbcBuildTaskRepository tasks,
            ArtifactStorage artifacts, BuildConcurrencyGuard guard) {
        this.worker = worker;
        this.tasks = tasks;
        this.artifacts = artifacts;
        this.guard = guard;
    }

    public Map<String, Object> buildAndRecord(long tenantId, Long appId, Long pageId,
            String sourceCode, String runtimeVersion, Long operatorId) {
        String sourceHash = sha256(sourceCode);

        // 幂等前置（§2.4 同源码复用）：命中成功任务直接回产物，不进编译
        String reused = tasks.findSuccessHash(tenantId, sourceHash);
        if (reused != null) {
            return Map.of("artifactUrl", artifactUrl(tenantId, reused), "contentHash", reused, "reused", true);
        }

        if (!guard.tryAcquire(tenantId, TENANT_CONCURRENCY_LIMIT)) {
            throw new BizException("BUILD_QUOTA_EXCEEDED", "构建并发已达上限，请稍后重试");
        }
        try {
            BuildTask.Result r = build(new BuildCommand(tenantId, appId, pageId, sourceCode, runtimeVersion));

            String status = r.success() ? "SUCCESS"
                    : hasSecurityViolation(r) ? "SECURITY_BLOCKED" : "FAILED";
            String errorsJson = r.errors() == null || r.errors().isEmpty()
                    ? null : Json.write(r.errors().stream().map(BuildTask.CompileError::toMap).toList());
            tasks.insert(tenantId, appId, pageId, sourceHash, r.contentHash(), status, errorsJson,
                    r.durationMs(), operatorId);

            if (r.success()) {
                Map<String, Object> resp = new LinkedHashMap<>();
                resp.put("artifactUrl", artifactUrl(tenantId, r.contentHash()));
                resp.put("contentHash", r.contentHash());
                return resp;
            }
            // SECURITY_BLOCKED → 422（04BE §A.6）；编译拒绝经 BizException 走统一错误体
            if ("SECURITY_BLOCKED".equals(status)) {
                Map<String, Object> details = new LinkedHashMap<>();
                details.put("errors", r.errors().stream().map(BuildTask.CompileError::toMap).toList());
                throw new BizException("SECURITY_BLOCKED", "脚本命中红线，编译被拒绝", details);
            }
            Map<String, Object> details = new LinkedHashMap<>();
            details.put("errors", r.errors() == null ? List.of()
                    : r.errors().stream().map(BuildTask.CompileError::toMap).toList());
            throw new BizException("COMPILE_FAILED", "编译失败", details);
        } finally {
            guard.release(tenantId);
        }
    }

    /** 领域入口（幂等/配额由本服务编排层负责）。 */
    @Override
    public BuildTask.Result build(BuildCommand command) {
        BuildTask.Result r = worker.compile(command.sourceCode());
        if (r.success() && r.artifact() != null) {
            // 产物上传④：contentHash 命名不可变；同 hash 已存在跳过
            artifacts.write(command.tenantId(), r.contentHash(),
                    r.artifact().getBytes(StandardCharsets.UTF_8));
        } else if (!r.success()) {
            log.info("build rejected: {} errors", r.errors() == null ? 0 : r.errors().size());
        }
        return r;
    }

    public Map<String, Object> taskStatus(long tenantId, long taskId) {
        Map<String, Object> row = tasks.findById(tenantId, taskId);
        if (row == null) {
            throw new BizException("BUILD_TASK_NOT_FOUND", "构建任务不存在");
        }
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("status", row.get("status"));
        if (row.get("content_hash") != null) {
            resp.put("contentHash", row.get("content_hash"));
            resp.put("artifactUrl", artifactUrl(tenantId, (String) row.get("content_hash")));
        }
        Object errors = row.get("errors");
        if (errors != null) {
            resp.put("errors", Json.readList(errors.toString()));
        }
        return resp;
    }

    /** 产物下载端点数据源（Worker 脚本响应头 CSP 由接口层下发——04BE §2.5②）。 */
    public byte[] artifact(long tenantId, String contentHash) {
        if (!contentHash.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("非法产物键");
        }
        return artifacts.read(tenantId, contentHash);
    }

    private static boolean hasSecurityViolation(BuildTask.Result r) {
        return r.errors() != null && r.errors().stream()
                .anyMatch(e -> e.code() != null && !e.code().equals("COMPILE_ERROR")
                        && !e.code().equals("SYNTAX_ERROR") && !e.code().equals("ARTIFACT_TOO_LARGE")
                        && !e.code().equals("BUILD_TIMEOUT") && !e.code().startsWith("WORKER"));
    }

    private static String artifactUrl(long tenantId, String contentHash) {
        return "/api/build/artifacts/%d/%s.js".formatted(tenantId, contentHash);
    }

    static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
