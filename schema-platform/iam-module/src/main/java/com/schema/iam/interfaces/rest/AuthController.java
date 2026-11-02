package com.schema.iam.interfaces.rest;

import com.schema.iam.application.AuthService;
import com.schema.iam.infrastructure.security.SessionCookies;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
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
 * 认证与成员 REST（03BE §A.1/§A.2/§A.3/§A.3.1；v0.4 Cookie 会话通道）。
 * 接口层只做协议转换；登录/刷新等公开端点租户取自请求体或默认租户（单租户退化约束）。
 * 会话三件套经 Set-Cookie 签发（响应体不含 refresh token——前端零凭证存储）。
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

    /** 会话响应：拉取应用层签发的三件套写 Set-Cookie，再回业务体。 */
    private static Map<String, Object> withSessionCookies(Map<String, Object> resp,
            HttpServletResponse response) {
        AuthService.SessionIssue session = AuthService.consumeSessionIssue();
        if (session != null) {
            SessionCookies.issue(response, session.accessToken(), session.refreshToken(),
                    session.csrfValue());
        }
        return resp;
    }

    // ---------- §A.1 认证（v0.4：Set-Cookie 签发；refresh/logout 零 body 兼容旧 body） ----------

    @PostMapping("/api/auth/login")
    public Map<String, Object> login(@RequestBody Map<String, Object> body,
            HttpServletRequest req, HttpServletResponse resp) {
        TenantInfo ctx = TenantContext.get();
        long tenantId = lng(body.get("tenantId")) != null ? lng(body.get("tenantId")) : ctx.tenantId();
        Map<String, Object> result = auth.login(tenantId, str(body.get("username")),
                str(body.get("password")), clientIp(req), ua(req));
        return withSessionCookies(result, resp);
    }

    /** 匿名 csrf 签发（登录页加载即调——登录 CSRF 防护；已登录调用滚动当前会话 csrf）。 */
    @GetMapping("/api/auth/csrf")
    public Map<String, Object> csrf(HttpServletRequest req, HttpServletResponse resp) {
        // 已登录会话由应用层管理滚动；此处匿名签发（或续签既有值语义不变——前端只读 cookie 注入头）
        SessionCookies.issueCsrfOnly(resp, SessionCookies.newCsrfValue());
        return Map.of();
    }

    @PostMapping("/api/auth/refresh")
    public Map<String, Object> refresh(@RequestBody(required = false) Map<String, Object> body,
            HttpServletRequest req, HttpServletResponse resp) {
        // v0.4：零 body（schema_rt cookie 自动携带）；过渡期兼容旧 body 传 refreshToken 的调用方
        String refreshToken = SessionCookies.read(req, SessionCookies.RT);
        if ((refreshToken == null || refreshToken.isBlank()) && body != null) {
            refreshToken = str(body.get("refreshToken"));
        }
        Map<String, Object> result = auth.refresh(refreshToken, clientIp(req), ua(req));
        return withSessionCookies(result, resp);
    }

    @PostMapping("/api/auth/logout")
    public Map<String, Object> logout(@RequestBody(required = false) Map<String, Object> body,
            HttpServletRequest req, HttpServletResponse resp) {
        // v0.4：零 body（schema_rt cookie 携带；兼容旧 body）
        String refreshToken = SessionCookies.read(req, SessionCookies.RT);
        if ((refreshToken == null || refreshToken.isBlank()) && body != null) {
            refreshToken = str(body.get("refreshToken"));
        }
        auth.logout(refreshToken);
        SessionCookies.clear(resp);
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
    public Map<String, Object> changePassword(@RequestBody Map<String, Object> body,
            HttpServletRequest req, HttpServletResponse resp) {
        TenantInfo ctx = TenantContext.get();
        Map<String, Object> result = auth.changePassword(ctx.tenantId(), ctx.operatorId(),
                str(body.get("oldPassword")), str(body.get("newPassword")), clientIp(req), ua(req));
        return withSessionCookies(result, resp);
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
