package com.schema.app.interfaces.rest;

import com.schema.app.application.AppService;
import com.schema.iam.application.AppRoleService;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 应用生命周期与导航（13BE §A.1/§A.2）。
 * 接口层只做协议转换与租户上下文装配（四层职责铁律）。
 * 成员端点在 IAM 侧 AppMemberController（角色经 permission 口径收口）。
 */
@RestController
public class AppController {

    private final AppService apps;
    private final AppRoleService appRoles;

    public AppController(AppService apps, AppRoleService appRoles) {
        this.apps = apps;
        this.appRoles = appRoles;
    }

    // ---------- §A.1 应用生命周期 ----------

    @PostMapping("/api/apps")
    public Map<String, Object> create(@RequestBody Map<String, Object> body, HttpServletRequest req) {
        return apps.create(str(body.get("name")), longOrNull(body.get("iconFileId")),
                str(body.get("description")), str(body.get("theme")), ip(req), ua(req));
    }

    @GetMapping("/api/apps")
    public Map<String, Object> list(@RequestParam(required = false) String keyword,
            @RequestParam(defaultValue = "false") boolean includeArchived) {
        return apps.list(keyword, includeArchived);
    }

    @GetMapping("/api/apps/{id}")
    public Map<String, Object> detail(@PathVariable long id) {
        return apps.detail(id);
    }

    @PutMapping("/api/apps/{id}")
    public Map<String, Object> update(@PathVariable long id, @RequestBody Map<String, Object> body) {
        apps.update(id, str(body.get("name")), longOrNull(body.get("iconFileId")),
                str(body.get("description")), str(body.get("theme")));
        return Map.of();
    }

    @PostMapping("/api/apps/{id}/archive")
    public Map<String, Object> archive(@PathVariable long id) {
        apps.archive(id);
        return Map.of();
    }

    @PostMapping("/api/apps/{id}/restore")
    public Map<String, Object> restore(@PathVariable long id) {
        apps.restore(id);
        return Map.of();
    }

    @DeleteMapping("/api/apps/{id}")
    public Map<String, Object> delete(@PathVariable long id) {
        return apps.delete(id);
    }

    // ---------- §A.2 导航 ----------

    @GetMapping("/api/apps/{id}/nav")
    public Map<String, Object> nav(@PathVariable long id,
            @RequestParam(defaultValue = "false") boolean filtered) {
        return apps.getNav(id, filtered);
    }

    @PutMapping("/api/apps/{id}/nav")
    public Map<String, Object> saveNav(@PathVariable long id, @RequestBody Map<String, Object> body) {
        List<Object> tree = body.get("tree") instanceof List<?> l
                ? (List<Object>) l : List.of();
        int version = body.get("version") instanceof Number n ? n.intValue() : 0;
        return apps.saveNav(id, tree, version);
    }

    // ---------- 成员（转发 IAM AppRoleService，13BE §A.2） ----------

    @GetMapping("/api/apps/{id}/members")
    public Map<String, Object> members(@PathVariable long id) {
        TenantInfo ctx = TenantContext.get();
        return Map.of("list", appRoles.listMembers(ctx.tenantId(), id));
    }

    @PostMapping("/api/apps/{id}/members")
    public Map<String, Object> addMember(@PathVariable long id, @RequestBody Map<String, Object> body,
            HttpServletRequest req) {
        TenantInfo ctx = TenantContext.get();
        appRoles.addMember(ctx.tenantId(), id, lng(body.get("userId")), strList(body.get("roles")),
                ctx.operatorId(), ip(req), ua(req));
        return Map.of();
    }

    @PutMapping("/api/apps/{id}/members/{userId}")
    public Map<String, Object> updateMember(@PathVariable long id, @PathVariable long userId,
            @RequestBody Map<String, Object> body, HttpServletRequest req) {
        TenantInfo ctx = TenantContext.get();
        appRoles.updateMemberRoles(ctx.tenantId(), id, userId, strList(body.get("roles")),
                ctx.operatorId(), ip(req), ua(req));
        return Map.of();
    }

    @DeleteMapping("/api/apps/{id}/members/{userId}")
    public Map<String, Object> removeMember(@PathVariable long id, @PathVariable long userId,
            HttpServletRequest req) {
        TenantInfo ctx = TenantContext.get();
        appRoles.removeMember(ctx.tenantId(), id, userId, ctx.operatorId(), ip(req), ua(req));
        return Map.of();
    }

    // ---------- 协议转换 ----------

    private static String str(Object v) {
        return v instanceof String s ? s : null;
    }

    private static Long longOrNull(Object v) {
        return v instanceof Number n ? n.longValue() : (v instanceof String s && !s.isBlank()
                ? Long.parseLong(s) : null);
    }

    private static long lng(Object v) {
        if (v instanceof Number n) {
            return n.longValue();
        }
        if (v instanceof String s && !s.isBlank()) {
            return Long.parseLong(s);
        }
        throw new IllegalArgumentException("数值字段缺失或非法");
    }

    @SuppressWarnings("unchecked")
    private static List<String> strList(Object v) {
        return v instanceof List<?> l ? (List<String>) l : List.of();
    }

    private static String ip(HttpServletRequest req) {
        return req != null && req.getHeader("X-Forwarded-For") != null
                ? req.getHeader("X-Forwarded-For") : (req != null ? req.getRemoteAddr() : null);
    }

    private static String ua(HttpServletRequest req) {
        return req != null ? req.getHeader("User-Agent") : null;
    }
}