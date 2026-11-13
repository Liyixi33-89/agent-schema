package com.schema.app.interfaces.rest;

import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 平台运营支撑（console-p1 最小集，13BE §6 分期口径）：
 * - 健康状态：DB 探活 + 版本（轻量自实现，不引 actuator——依赖最小化）；
 * - 维护公告：单生效行读写（同租户至多一行 active）。
 * 租户清单/档位调整/模板管理为 P2 范围（13BE §6/§4 分期决策）。
 * 写操作走 org:manage 权限闸（平台管理端动作）。
 */
@RestController
public class OpsController {

    private final JdbcTemplate jdbc;
    private final com.schema.iam.domain.repository.IamRepository iam;

    public OpsController(JdbcTemplate jdbc, com.schema.iam.domain.repository.IamRepository iam) {
        this.jdbc = jdbc;
        this.iam = iam;
    }

    // ---------- 健康 ----------

    @GetMapping("/api/ops/health")
    public Map<String, Object> health() {
        Map<String, Object> resp = new LinkedHashMap<>();
        try {
            jdbc.queryForObject("SELECT 1", Integer.class);
            resp.put("db", "UP");
        } catch (Exception e) {
            resp.put("db", "DOWN");
        }
        resp.put("status", "UP".equals(resp.get("db")) ? "UP" : "DEGRADED");
        resp.put("version", "0.1.0");
        resp.put("timestamp", java.time.OffsetDateTime.now().toString());
        return resp;
    }

    // ---------- 租户健康页（10BE §4.1 聚合接口——org:manage 闸门） ----------

    /**
     * 健康总览（近 1h）：db 探活 + 活跃用户数 + API 吞吐/错误率 + 脚本编译成功率 + 资源占用。
     * 错误率口径：平台无逐请求状态码日志（09BE §4 网关层采集随 P2）——以审计失败事件
     * （SECURITY/失败类变更）+ 编译失败/安全拦截为错误计数代理，errorRate 字段标注
     * source=proxy；吞吐来自 usage_event api.calls（漏斗口径，非全量请求）。
     */
    @GetMapping("/api/ops/health/tenant/overview")
    public Map<String, Object> tenantHealthOverview() {
        TenantInfo ctx = TenantContext.get();
        requireOrgManage(ctx);
        Map<String, Object> resp = new LinkedHashMap<>();
        // db 探活（与 /health 同口径）
        String db;
        try {
            jdbc.queryForObject("SELECT 1", Integer.class);
            db = "UP";
        } catch (Exception e) {
            db = "DOWN";
        }
        java.time.OffsetDateTime since = java.time.OffsetDateTime.now().minusHours(1);
        // 近 1h 活跃用户（seat.active 去重 user_id）
        Long activeUsers = jdbc.queryForObject(
                "SELECT count(DISTINCT user_id) FROM usage_event WHERE tenant_id=? AND metric='seat.active' AND occurred_at>=?",
                Long.class, ctx.tenantId(), since);
        // 近 1h API 吞吐（api.calls 总量；无事件记 0——漏斗口径）
        Long apiCalls = jdbc.queryForObject(
                "SELECT coalesce(sum(quantity),0) FROM usage_event WHERE tenant_id=? AND metric='api.calls' AND occurred_at>=?",
                Long.class, ctx.tenantId(), since);
        // 近 1h 错误计数（代理口径：审计失败类事件 + 编译失败/安全拦截）
        Long auditErr = jdbc.queryForObject(
                "SELECT count(*) FROM sys_audit_log WHERE tenant_id=? AND created_at>=? "
                        + "AND event_type IN ('SECURITY','SCHEMA_CHANGE','PERM_CHANGE')",
                Long.class, ctx.tenantId(), since);
        Long buildErr = jdbc.queryForObject(
                "SELECT count(*) FROM build_task WHERE tenant_id=? AND created_at>=? "
                        + "AND status IN ('FAILED','SECURITY_BLOCKED')",
                Long.class, ctx.tenantId(), since);
        long errors = (auditErr == null ? 0 : auditErr) + (buildErr == null ? 0 : buildErr);
        // 近 1h 编译成功率
        Long buildTotal = jdbc.queryForObject(
                "SELECT count(*) FROM build_task WHERE tenant_id=? AND created_at>=?", Long.class, ctx.tenantId(), since);
        Long buildOk = jdbc.queryForObject(
                "SELECT count(*) FROM build_task WHERE tenant_id=? AND created_at>=? AND status='SUCCESS'",
                Long.class, ctx.tenantId(), since);
        // 资源占用：文件存储 MB（file_object size_bytes 合计；status=ACTIVE 才计入——PENDING 未落盘/EXPIRED 已失效）+ 业务表行数概览
        Double storageMb = jdbc.queryForObject(
                "SELECT coalesce(sum(size_bytes),0)/1048576.0 FROM file_object WHERE tenant_id=? AND status='ACTIVE'",
                Double.class, ctx.tenantId());
        resp.put("db", db);
        resp.put("activeUsersLastHour", activeUsers == null ? 0 : activeUsers);
        resp.put("apiThroughputLastHour", Map.of(
                "calls", apiCalls == null ? 0 : apiCalls,
                "source", "usage_event.api.calls"));
        resp.put("errorRateLastHour", Map.of(
                "errors", errors,
                "source", "proxy:audit+build"));
        // successRate 可空（零样本时无成功率——Map.of 不容 null，改 LinkedHashMap）
        Map<String, Object> compile = new LinkedHashMap<>();
        compile.put("total", buildTotal == null ? 0 : buildTotal);
        compile.put("success", buildOk == null ? 0 : buildOk);
        compile.put("successRate", buildTotal != null && buildTotal > 0
                ? Math.round((buildOk == null ? 0 : buildOk) * 1000.0 / buildTotal) / 10.0 : null);
        resp.put("scriptCompileLastHour", compile);
        resp.put("resourceUsage", Map.of(
                "storageMb", storageMb == null ? 0 : Math.round(storageMb * 10) / 10.0));
        resp.put("timestamp", java.time.OffsetDateTime.now().toString());
        return resp;
    }

    /** API 吞吐时序（近 N 分钟，默认 60）：api.calls 分钟聚合 [{minute, calls}]。 */
    @GetMapping("/api/ops/health/tenant/api-throughput")
    public Map<String, Object> tenantApiThroughput(@RequestParam(defaultValue = "60") int minutes) {
        TenantInfo ctx = TenantContext.get();
        requireOrgManage(ctx);
        if (minutes < 1 || minutes > 1440) {
            throw new IllegalArgumentException("minutes 须在 1-1440 之间");
        }
        java.time.OffsetDateTime since = java.time.OffsetDateTime.now().minusMinutes(minutes);
        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT date_trunc('minute', occurred_at) AS minute, sum(quantity) AS calls
                FROM usage_event
                WHERE tenant_id=? AND metric='api.calls' AND occurred_at>=?
                GROUP BY 1 ORDER BY 1
                """, ctx.tenantId(), since);
        List<Map<String, Object>> series = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            Map<String, Object> point = new LinkedHashMap<>();
            point.put("minute", String.valueOf(row.get("minute")));
            point.put("calls", row.get("calls"));
            series.add(point);
        }
        return Map.of("series", series);
    }

    /** 脚本编译时序（近 N 小时，默认 24）：[{hour, total, success, failed, blocked, medianDurationMs}]。 */
    @GetMapping("/api/ops/health/tenant/script-compile")
    public Map<String, Object> tenantScriptCompile(@RequestParam(defaultValue = "24") int hours) {
        TenantInfo ctx = TenantContext.get();
        requireOrgManage(ctx);
        if (hours < 1 || hours > 168) {
            throw new IllegalArgumentException("hours 须在 1-168 之间");
        }
        java.time.OffsetDateTime since = java.time.OffsetDateTime.now().minusHours(hours);
        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT date_trunc('hour', created_at) AS hour, count(*) AS total,
                       count(*) FILTER (WHERE status='SUCCESS') AS success,
                       count(*) FILTER (WHERE status='FAILED') AS failed,
                       count(*) FILTER (WHERE status='SECURITY_BLOCKED') AS blocked,
                       percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS median_duration_ms
                FROM build_task
                WHERE tenant_id=? AND created_at>=?
                GROUP BY 1 ORDER BY 1
                """, ctx.tenantId(), since);
        List<Map<String, Object>> series = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            Map<String, Object> point = new LinkedHashMap<>();
            point.put("hour", String.valueOf(row.get("hour")));
            point.put("total", row.get("total"));
            point.put("success", row.get("success"));
            point.put("failed", row.get("failed"));
            point.put("blocked", row.get("blocked"));
            point.put("medianDurationMs", row.get("median_duration_ms"));
            series.add(point);
        }
        return Map.of("series", series);
    }

    /** 近期错误事件（默认 20 条）：审计失败类 + 编译失败/安全拦截，统一时间倒序。 */
    @GetMapping("/api/ops/health/tenant/recent-errors")
    public Map<String, Object> tenantRecentErrors(@RequestParam(defaultValue = "20") int limit) {
        TenantInfo ctx = TenantContext.get();
        requireOrgManage(ctx);
        if (limit < 1 || limit > 100) {
            throw new IllegalArgumentException("limit 须在 1-100 之间");
        }
        List<Map<String, Object>> audit = jdbc.queryForList("""
                SELECT created_at, event_type, resource_type, resource_id, user_id
                FROM sys_audit_log
                WHERE tenant_id=? AND event_type IN ('SECURITY','SCHEMA_CHANGE','PERM_CHANGE')
                ORDER BY created_at DESC LIMIT ?
                """, ctx.tenantId(), limit);
        List<Map<String, Object>> builds = jdbc.queryForList("""
                SELECT created_at, status, page_id, source_hash, duration_ms
                FROM build_task
                WHERE tenant_id=? AND status IN ('FAILED','SECURITY_BLOCKED')
                ORDER BY created_at DESC LIMIT ?
                """, ctx.tenantId(), limit);
        // 合并取前 limit 条（时间倒序）
        List<Map<String, Object>> merged = new ArrayList<>();
        merged.addAll(audit.stream().map(r -> {
            Map<String, Object> e = new LinkedHashMap<>();
            e.put("kind", "AUDIT");
            e.put("at", String.valueOf(r.get("created_at")));
            e.put("type", r.get("event_type"));
            e.put("resource", r.get("resource_type") + ":" + r.get("resource_id"));
            e.put("userId", r.get("user_id"));
            return e;
        }).toList());
        merged.addAll(builds.stream().map(r -> {
            Map<String, Object> e = new LinkedHashMap<>();
            e.put("kind", "BUILD");
            e.put("at", String.valueOf(r.get("created_at")));
            e.put("type", r.get("status"));
            e.put("resource", "page:" + r.get("page_id"));
            e.put("durationMs", r.get("duration_ms"));
            return e;
        }).toList());
        merged.sort((a, b) -> String.valueOf(b.get("at")).compareTo(String.valueOf(a.get("at"))));
        return Map.of("list", merged.subList(0, Math.min(limit, merged.size())));
    }

    // ---------- 维护公告 ----------

    /** 当前生效公告（登录态即可读——运行时顶部横幅消费）。 */
    @GetMapping("/api/ops/notices/active")
    public Map<String, Object> activeNotice() {
        TenantInfo ctx = TenantContext.get();
        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT id, title, content, level, updated_at FROM ops_notice
                WHERE tenant_id=? AND active=TRUE ORDER BY id DESC LIMIT 1
                """, ctx.tenantId());
        return rows.isEmpty() ? Map.of("notice", Map.of()) : Map.of("notice", rows.get(0));
    }

    /** 公告历史列表（org:manage 闸门）。 */
    @GetMapping("/api/ops/notices")
    public Map<String, Object> listNotices() {
        TenantInfo ctx = TenantContext.get();
        requireOrgManage(ctx);
        return Map.of("list", jdbc.queryForList(
                "SELECT id, title, content, level, active, created_at, updated_at FROM ops_notice "
                        + "WHERE tenant_id=? ORDER BY id DESC", ctx.tenantId()));
    }

    /** 发布/更新公告（org:manage）：同租户至多一行生效——发布即激活并撤销旧行；单事务防半态。 */
    @PostMapping("/api/ops/notices")
    @org.springframework.transaction.annotation.Transactional
    public Map<String, Object> upsertNotice(@RequestBody Map<String, Object> body) {
        TenantInfo ctx = TenantContext.get();
        requireOrgManage(ctx);
        String title = str(body.get("title"));
        String content = str(body.get("content"));
        String level = body.get("level") instanceof String l && !l.isBlank() ? l : "INFO";
        if (title == null || title.isBlank()) {
            throw new IllegalArgumentException("公告标题必填");
        }
        if (content == null || content.isBlank()) {
            throw new IllegalArgumentException("公告内容必填");
        }
        if (!"INFO".equals(level) && !"WARNING".equals(level) && !"CRITICAL".equals(level)) {
            throw new IllegalArgumentException("level 必须为 INFO/WARNING/CRITICAL");
        }
        jdbc.update("UPDATE ops_notice SET active=FALSE, updated_at=now() WHERE tenant_id=? AND active=TRUE",
                ctx.tenantId());
        jdbc.update("""
                INSERT INTO ops_notice (tenant_id, title, content, level, active, operator_id)
                VALUES (?, ?, ?, ?, TRUE, ?)
                """, ctx.tenantId(), title, content, level, ctx.operatorId());
        return Map.of();
    }

    /** 撤下公告（org:manage）。 */
    @PutMapping("/api/ops/notices/deactivate")
    public Map<String, Object> deactivate() {
        TenantInfo ctx = TenantContext.get();
        requireOrgManage(ctx);
        jdbc.update("UPDATE ops_notice SET active=FALSE, updated_at=now() WHERE tenant_id=? AND active=TRUE",
                ctx.tenantId());
        return Map.of();
    }

    // ---------- 租户成员清单（03BE §A.3：admin-console 成员管理消费） ----------

    /** 组织成员列表（org:manage 闸门）：[{id, account, name, status, roles[]}]。 */
    @GetMapping("/api/org/members")
    public Map<String, Object> listOrgMembers() {
        TenantInfo ctx = TenantContext.get();
        requireOrgManage(ctx);
        List<Map<String, Object>> list = new ArrayList<>();
        for (Map<String, Object> u : jdbc.queryForList(
                "SELECT id, account, name, status FROM sys_user WHERE tenant_id=? ORDER BY id", ctx.tenantId())) {
            Map<String, Object> item = new LinkedHashMap<>(u);
            long uid = ((Number) u.get("id")).longValue();
            List<String> roleCodes = new ArrayList<>();
            for (Map<String, Object> r : iam.findRolesOfUser(ctx.tenantId(), uid)) {
                roleCodes.add((String) r.get("code"));
            }
            item.put("roles", roleCodes);
            list.add(item);
        }
        return Map.of("list", list);
    }

    // ---------- 内部 ----------

    /** org:manage 权限闸（与 IAM AuthService.requireOrgManagePerm 同构——逐请求实时判定，快照不作数）。 */
    private void requireOrgManage(TenantInfo ctx) {
        var operator = iam.findUserById(ctx.operatorId()).orElse(null);
        if (operator == null || operator.tenantId() != ctx.tenantId()) {
            throw BizException.permDenied();
        }
        List<Long> roleIds = new ArrayList<>();
        for (Map<String, Object> r : iam.findRolesOfUser(ctx.tenantId(), ctx.operatorId())) {
            roleIds.add(((Number) r.get("id")).longValue());
        }
        boolean granted = iam.findPermsOfRoles(roleIds).stream()
                .anyMatch(p -> "action:org:manage".equals(p.toPermString()));
        if (!granted) {
            throw BizException.permDenied();
        }
    }

    private static String str(Object v) {
        return v instanceof String s ? s : null;
    }
}