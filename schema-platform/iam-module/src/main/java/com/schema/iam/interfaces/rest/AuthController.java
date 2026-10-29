package com.schema.iam.interfaces.rest;

import com.schema.iam.application.AuthService;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 认证与成员 REST（03BE §A.1/§A.2/§A.3/§A.3.1）。
 * 接口层只做协议转换；登录/刷新等公开端点租户取自请求体或默认租户（单租户退化约束）。
 */
@RestController
public class AuthController {

    private final AuthService auth;

    public AuthController(AuthService auth) {
        this.auth = auth;
    }

    private static String str(Object v) {
        return v instanceof String s ? s : null;
    }

    private static Long lng(Object v) {
        return v instanceof Number n ? n.longValue()
                : v instanceof String s && !s.isBlank() ? Long.parseLong(s) : null;
    }

    private static String clientIp(HttpServletRequest req) {
        return req.getRemoteAddr();
    }

    private static String ua(HttpServletRequest req) {
        return req.getHeader("User-Agent");
    }

    // ---------- §A.1 认证 ----------

    @PostMapping("/api/auth/login")
    public Map<String, Object> login(@RequestBody Map<String, Object> body, HttpServletRequest req) {
        TenantInfo ctx = TenantContext.get();
        long tenantId = lng(body.get("tenantId")) != null ? lng(body.get("tenantId")) : ctx.tenantId();
        return auth.login(tenantId, str(body.get("username")), str(body.get("password")),
                clientIp(req), ua(req));
    }

    @PostMapping("/api/auth/refresh")
    public Map<String, Object> refresh(@RequestBody Map<String, Object> body, HttpServletRequest req) {
        return auth.refresh(str(body.get("refreshToken")), clientIp(req), ua(req));
    }

    @PostMapping("/api/auth/logout")
    public Map<String, Object> logout(@RequestBody Map<String, Object> body) {
        auth.logout(str(body.get("refreshToken")));
        return Map.of();
    }

    // ---------- §A.2 当前用户 ----------

    @GetMapping("/api/me")
    public Map<String, Object> me() {
        return auth.me();
    }

    // ---------- §A.3.1 成员生命周期 ----------

    @PostMapping("/api/org/members")
    public Map<String, Object> createMember(@RequestBody Map<String, Object> body, HttpServletRequest req) {
        TenantInfo ctx = TenantContext.get();
        return auth.createMember(ctx.tenantId(), str(body.get("username")), str(body.get("name")),
                lng(body.get("deptId")), str(body.get("initialPassword")),
                ctx.operatorId(), clientIp(req), ua(req));
    }

    @PostMapping("/api/auth/reset-password")
    public Map<String, Object> resetPassword(@RequestBody Map<String, Object> body, HttpServletRequest req) {
        TenantInfo ctx = TenantContext.get();
        return auth.resetPassword(ctx.tenantId(), lng(body.get("userId")),
                ctx.operatorId(), clientIp(req), ua(req));
    }

    @PutMapping("/api/me/password")
    public Map<String, Object> changePassword(@RequestBody Map<String, Object> body, HttpServletRequest req) {
        TenantInfo ctx = TenantContext.get();
        return auth.changePassword(ctx.tenantId(), ctx.operatorId(),
                str(body.get("oldPassword")), str(body.get("newPassword")), clientIp(req), ua(req));
    }

    // ---------- §A.3 授权 ----------

    @PostMapping("/api/org/members/{userId}/roles")
    public Map<String, Object> grantRoles(@PathVariable long userId, @RequestBody Map<String, Object> body,
            HttpServletRequest req) {
        TenantInfo ctx = TenantContext.get();
        @SuppressWarnings("unchecked")
        List<Long> roleIds = ((List<Object>) body.getOrDefault("roleIds", List.of())).stream()
                .map(v -> v instanceof Number n ? n.longValue() : Long.parseLong((String) v))
                .toList();
        auth.grantRoles(ctx.tenantId(), userId, lng(body.get("appId")), roleIds,
                ctx.operatorId(), clientIp(req), ua(req));
        return Map.of();
    }
}
