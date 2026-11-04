package com.schema.page.interfaces.rest;

import com.schema.page.application.PreviewGrantService;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 预览凭证（04BE §A.7）：签发/兑换/吊销闭环。
 * exchange 为公开端点（grant 本身即凭证——短时单次，兑换不叠加登录态）。
 */
@RestController
public class PreviewGrantController {

    private final PreviewGrantService service;

    public PreviewGrantController(PreviewGrantService service) {
        this.service = service;
    }

    @PostMapping("/api/apps/{appId}/preview-grants")
    public Map<String, Object> issue(@PathVariable long appId, @RequestBody(required = false) Map<String, Object> body) {
        Long pageId = body != null && body.get("pageId") != null
                ? Long.parseLong(String.valueOf(body.get("pageId"))) : null;
        boolean allowRealWrite = body != null && Boolean.TRUE.equals(body.get("allowRealWrite"));
        return service.issueGrant(appId, pageId, allowRealWrite);
    }

    @PostMapping("/api/preview/exchange")
    public Map<String, Object> exchange(@RequestBody Map<String, Object> body) {
        return service.exchange(String.valueOf(body.get("grantId")));
    }

    @DeleteMapping("/api/apps/{appId}/preview-grants")
    public Map<String, Object> revokeAll(@PathVariable long appId) {
        return service.revokeAll(appId);
    }

    @PostMapping("/api/preview/sessions/{sessionUuid}/revoke")
    public Map<String, Object> revokeSession(@PathVariable String sessionUuid,
            jakarta.servlet.http.HttpServletRequest request) {
        // 预览态自我吊销（2026-11-04）：预览 token 只能吊销自己（claims.jti = 会话 uuid）——
        // 防预览 token 吊销他人会话（DoS 面）。正式会话走 TenantContext 无此约束（发起人管理面）。
        Boolean preview = (Boolean) request.getAttribute("auth.preview");
        if (Boolean.TRUE.equals(preview)) {
            String selfJti = (String) request.getAttribute("auth.previewSessionId");
            if (selfJti == null || !selfJti.equals(sessionUuid)) {
                throw new org.springframework.web.server.ResponseStatusException(
                        org.springframework.http.HttpStatus.FORBIDDEN, "预览凭证仅可吊销本人会话");
            }
        }
        return service.revokeSession(sessionUuid);
    }
}
