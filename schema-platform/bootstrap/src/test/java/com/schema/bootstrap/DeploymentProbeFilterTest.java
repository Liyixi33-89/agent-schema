package com.schema.bootstrap;

import org.junit.jupiter.api.Test;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 部署探针单测（M16 发布体系）：
 * - liveness 恒 200 不触依赖；readiness 依赖 DB 且失败 503；
 * - 版本注入（APP_VERSION/GIT_COMMIT）缺失时 unknown；
 * - 非探针路径透传不过滤（业务链不受影响）。
 */
class DeploymentProbeFilterTest {

    /** 探针 JSON 断言用：直接判响应体键值。 */
    private static String body(MockHttpServletResponse resp) throws java.io.UnsupportedEncodingException {
        return resp.getContentAsString();
    }

    @Test
    void livenessAlwaysUpWithoutDb() throws Exception {
        AtomicInteger dbHits = new AtomicInteger();
        JdbcTemplate jdbc = new JdbcTemplate() {
            @Override
            public <T> T queryForObject(String sql, Class<T> requiredType) {
                dbHits.incrementAndGet();
                throw new IllegalStateException("DB 不可达");
            }
        };
        DeploymentProbeFilter filter = new DeploymentProbeFilter(jdbc, env(null, null));
        MockHttpServletResponse resp = probe(filter, "/internal/health/liveness");
        assertEquals(200, resp.getStatus());
        assertTrue(body(resp).contains("\"status\":\"UP\""));
        assertTrue(body(resp).contains("\"probe\":\"liveness\""));
        assertEquals(0, dbHits.get(), "liveness 不得触达数据库");
    }

    @Test
    void readinessDownWhenDbUnavailable() throws Exception {
        JdbcTemplate jdbc = new JdbcTemplate() {
            @Override
            public <T> T queryForObject(String sql, Class<T> requiredType) {
                throw new IllegalStateException("DB 不可达");
            }
        };
        DeploymentProbeFilter filter = new DeploymentProbeFilter(jdbc, env(null, null));
        MockHttpServletResponse resp = probe(filter, "/internal/health/readiness");
        assertEquals(503, resp.getStatus());
        assertTrue(body(resp).contains("\"status\":\"DOWN\""));
    }

    @Test
    void readinessUpWhenDbReachable() throws Exception {
        JdbcTemplate jdbc = new JdbcTemplate() {
            @Override
            public <T> T queryForObject(String sql, Class<T> requiredType) {
                return null; // SELECT 1 成功
            }
        };
        DeploymentProbeFilter filter = new DeploymentProbeFilter(jdbc, env("1.2.3", "abc1234"));
        MockHttpServletResponse resp = probe(filter, "/internal/health/readiness");
        assertEquals(200, resp.getStatus());
        assertTrue(body(resp).contains("\"version\":\"1.2.3\""));
        assertTrue(body(resp).contains("\"commit\":\"abc1234\""));
    }

    @Test
    void versionFallsBackToUnknown() throws Exception {
        JdbcTemplate jdbc = okJdbc();
        DeploymentProbeFilter filter = new DeploymentProbeFilter(jdbc, env(null, null));
        MockHttpServletResponse resp = probe(filter, "/internal/health/readiness");
        assertTrue(body(resp).contains("\"version\":\"unknown\""));
        assertTrue(body(resp).contains("\"commit\":\"unknown\""));
    }

    @Test
    void nonProbePathsPassThroughUntouched() throws Exception {
        JdbcTemplate jdbc = okJdbc();
        DeploymentProbeFilter filter = new DeploymentProbeFilter(jdbc, env("v", "c"));
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/me");
        MockHttpServletResponse response = new MockHttpServletResponse();
        boolean[] chained = {false};
        filter.doFilter(request, response, (req, res) -> chained[0] = true);
        assertTrue(chained[0], "业务路径必须透传");
        assertEquals(200, response.getStatus());
        assertEquals("", body(response));
    }

    @Test
    void jsonEscapesHostileValues() throws Exception {
        DeploymentProbeFilter filter = new DeploymentProbeFilter(okJdbc(),
                env("v\"quote", "c\\slash"));
        MockHttpServletResponse resp = probe(filter, "/internal/health/liveness");
        assertTrue(body(resp).contains("v\\\"quote"));
        assertTrue(body(resp).contains("c\\\\slash"));
    }

    // ---------- 辅助 ----------

    private static JdbcTemplate okJdbc() {
        return new JdbcTemplate() {
            @Override
            public <T> T queryForObject(String sql, Class<T> requiredType) {
                return null;
            }
        };
    }

    private static Environment env(String version, String commit) {
        MockEnvironment e = new MockEnvironment();
        if (version != null) {
            e.setProperty("app.version", version);
        }
        if (commit != null) {
            e.setProperty("git.commit", commit);
        }
        return e;
    }

    private static MockHttpServletResponse probe(DeploymentProbeFilter filter, String path)
            throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", path);
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter.doFilter(request, response, (req, res) -> fail("探针路径不得透传"));
        return response;
    }
}
