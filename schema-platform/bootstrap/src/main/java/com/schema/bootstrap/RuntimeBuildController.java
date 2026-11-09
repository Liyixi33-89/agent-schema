package com.schema.bootstrap;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** 运行实例身份：只读取启动时类路径内固化标识，不读取可被替换的磁盘 JAR。 */
@RestController
public class RuntimeBuildController {
    private final String instanceId = UUID.randomUUID().toString();
    private final String sourceCommit;

    public RuntimeBuildController() {
        this(readSourceCommit());
    }

    RuntimeBuildController(String sourceCommit) {
        this.sourceCommit = sourceCommit != null && sourceCommit.matches("[0-9a-f]{40}")
                ? sourceCommit : null;
    }

    private static String readSourceCommit() {
        try (InputStream stream = RuntimeBuildController.class.getResourceAsStream("/build-source.txt")) {
            if (stream == null) return null;
            String value = new String(stream.readNBytes(128), StandardCharsets.UTF_8).trim();
            return value.matches("[0-9a-f]{40}") ? value : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    // 保持既有认证链路，不增加匿名白名单；不泄露环境变量、路径或配置。
    @GetMapping("/api/system/build-identity")
    public ResponseEntity<Map<String, Object>> identity() {
        if (sourceCommit == null) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                    .cacheControl(CacheControl.noStore())
                    .body(Map.of("verifiable", false, "instanceId", instanceId));
        }
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(Map.of("verifiable", true, "sourceCommit", sourceCommit, "instanceId", instanceId));
    }
}
