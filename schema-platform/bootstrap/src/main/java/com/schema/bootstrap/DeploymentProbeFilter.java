package com.schema.bootstrap;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.annotation.Order;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 部署探针端点（M16 发布体系最小集，13BE §6 轻量自实现口径）：
 * - GET /internal/health/liveness ：进程存活——不触达任何依赖，恒 200（仅挂点标识进程死亡）；
 * - GET /internal/health/readiness：就绪判定——数据库 SELECT 1 可达才算就绪（发布验证/滚动切换消费）。
 *
 * 边界约束：
 * 1) 免鉴权且路径不走 /api/**——公开互联网只能拿到一行 UP/DOWN 与版本号，无租户/账号/内部细节；
 * 2) 与业务安全链完全解耦：本过滤器最先执行且对这两个路径直接短路，不再进入 Csrf/Jwt/Tenant 链；
 * 3) 版本信息来自构建注入（APP_VERSION / GIT_COMMIT 环境变量，systemd Environment 或 -D 传入），
 *    未注入时显示 unknown——线上可回答「跑的是哪个 commit」，不再靠文件时间猜测。
 *
 * HTTPS 预留：当前无域名暂不上 TLS（用户决策 2026-11-03）；上线时仅需在 nginx 加 443 server 块
 * 与后端 trusted-proxy 配置（X-Forwarded-Proto），本探针与 Cookie 属性（Secure）不受影响。
 */
@Component
@Order(-100)
public class DeploymentProbeFilter extends OncePerRequestFilter {

    /** 探针路径前缀（internal = 公网可见但信息最小化：只有状态行与版本号）。 */
    private static final String LIVENESS_PATH = "/internal/health/liveness";
    private static final String READINESS_PATH = "/internal/health/readiness";

    private final JdbcTemplate jdbc;
    private final String appVersion;
    private final String gitCommit;

    public DeploymentProbeFilter(JdbcTemplate jdbc, Environment env) {
        this.jdbc = jdbc;
        this.appVersion = resolve(env, "APP_VERSION", "app.version");
        this.gitCommit = resolve(env, "GIT_COMMIT", "git.commit");
    }

    private static String resolve(Environment env, String envKey, String propKey) {
        String v = System.getenv(envKey);
        if (v == null || v.isBlank()) {
            v = env.getProperty(propKey);
        }
        return (v == null || v.isBlank()) ? "unknown" : v;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain chain) throws ServletException, IOException {
        String path = request.getRequestURI();
        if (!LIVENESS_PATH.equals(path) && !READINESS_PATH.equals(path)) {
            chain.doFilter(request, response);
            return;
        }
        boolean ready = LIVENESS_PATH.equals(path) ? true : checkDb();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", ready ? "UP" : "DOWN");
        body.put("version", appVersion);
        body.put("commit", gitCommit);
        body.put("probe", LIVENESS_PATH.equals(path) ? "liveness" : "readiness");
        body.put("timestamp", java.time.OffsetDateTime.now().toString());
        response.setStatus(ready ? 200 : 503);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write(toJson(body));
    }

    /** 就绪判定：数据库可达即就绪（最小依赖面——当前栈无 Redis/Kafka，不加探活项）。 */
    private boolean checkDb() {
        try {
            jdbc.queryForObject("SELECT 1", Integer.class);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** 最小 JSON 序列化（响应体固定五键，不引序列化库）。 */
    private static String toJson(Map<String, Object> body) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Object> e : body.entrySet()) {
            if (!first) {
                sb.append(',');
            }
            first = false;
            sb.append('"').append(e.getKey()).append("\":\"");
            sb.append(String.valueOf(e.getValue()).replace("\\", "\\\\").replace("\"", "\\\""));
            sb.append('"');
        }
        return sb.append('}').toString();
    }
}
