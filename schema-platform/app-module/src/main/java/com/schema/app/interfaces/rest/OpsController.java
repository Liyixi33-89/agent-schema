package com.schema.app.interfaces.rest;

import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
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

    /** 发布/更新公告（org:manage）：同租户至多一行生效——发布即激活并撤销旧行。 */
    @PostMapping("/api/ops/notices")
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