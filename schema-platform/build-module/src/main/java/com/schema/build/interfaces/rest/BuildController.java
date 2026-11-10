package com.schema.build.interfaces.rest;

import com.schema.build.application.BuildCommandService;
import com.schema.platform.common.tenant.TenantContext;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * 代码编译接口（04BE §A.5）+ 产物下载（§2.5② Worker 脚本响应头 CSP 独立下发）。
 * 权限：页面脚本编译 = 应用设计能力（与页面草稿保存同门——designGate 由组合根装配）。
 */
@RestController
public class BuildController {

    private final BuildCommandService service;
    private final DesignCapabilityGate designGate;

    public BuildController(BuildCommandService service, DesignCapabilityGate designGate) {
        this.service = service;
        this.designGate = designGate;
    }

    /** POST /api/build/pages/{pageId}/code —— 保存即编译；成功 {artifactUrl, contentHash}。 */
    @PostMapping("/api/build/pages/{pageId}/code")
    public ResponseEntity<Map<String, Object>> build(@PathVariable long pageId,
            @RequestBody Map<String, Object> body) {
        TenantInfo t = current();
        designGate.requireDesignCapability(t.appId());
        String sourceCode = str(body.get("sourceCode"));
        if (sourceCode == null) {
            throw new IllegalArgumentException("sourceCode 不能为空");
        }
        Map<String, Object> resp = service.buildAndRecord(t.tenantId(), t.appId(), pageId,
                sourceCode, str(body.get("runtimeVersion")), t.operatorId());
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(resp);
    }

    /** GET /api/build/tasks/{taskId} —— 前端轮询（04BE §A.5）。 */
    @GetMapping("/api/build/tasks/{taskId}")
    public ResponseEntity<Map<String, Object>> task(@PathVariable long taskId) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(service.taskStatus(current().tenantId(), taskId));
    }

    /**
     * GET /api/build/artifacts/{tenantId}/{contentHash}.js —— Worker import() 产物端点。
     * 响应头独立下发 CSP（04BE §2.5②：Worker 的 CSP 由其脚本自身响应头控制，不依赖宿主传递）：
     * connect-src 'none' —— Worker 内发起的任何网络请求被浏览器阻断（出口策略二次封死）。
     * {tenantId} 支持 current 别名（设计器测试台不知会话租户号时按会话解析）。
     */
    @GetMapping({"/api/build/artifacts/{tenantId}/{contentHash}.js", "/api/build/artifacts/current/{contentHash}.js"})
    public ResponseEntity<byte[]> artifact(@PathVariable(required = false) Long tenantId,
            @PathVariable String contentHash) {
        TenantInfo t = current();
        if (tenantId != null && tenantId != t.tenantId()) {
            // 跨租户产物键不给存在性线索
            throw new IllegalArgumentException("非法产物键");
        }
        byte[] body = service.artifact(t.tenantId(), contentHash);
        return ResponseEntity.ok()
                .header(HttpHeaders.CACHE_CONTROL, "public, max-age=31536000, immutable")
                .header("Content-Security-Policy", "connect-src 'none'; script-src 'self'")
                .contentType(new MediaType("application", "javascript", StandardCharsets.UTF_8))
                .body(body);
    }

    private static TenantInfo current() {
        var info = TenantContext.get();
        return new TenantInfo(info.tenantId(), info.appId(), info.operatorId());
    }

    private static String str(Object v) {
        return v instanceof String s ? s : null;
    }

    private record TenantInfo(long tenantId, long appId, long operatorId) {
    }
}
