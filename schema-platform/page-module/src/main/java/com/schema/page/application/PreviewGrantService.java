package com.schema.page.application;

import com.schema.iam.domain.model.UserAccount;
import com.schema.iam.domain.repository.IamRepository;
import com.schema.iam.infrastructure.security.JwtCodec;
import com.schema.page.domain.repository.PreviewGrantRepository;
import com.schema.page.domain.repository.PreviewGrantRepository.Grant;
import com.schema.page.domain.repository.PreviewGrantRepository.Session;
import com.schema.platform.common.json.Json;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.security.SecureRandom;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 预览凭证服务（04BE §A.7）：grant 5min 单次 → exchange 短时会话（15min）→ 吊销闭环。
 *
 * 安全约束：
 * - grantId 服务端生成（UUID v4 不可预测）；exchange 幂等（用后即毁，重放 401 GRANT_CONSUMED）；
 * - 绑定约束：grant 绑定 {tenantId, appId, pageId?, 发起人}；exchange 校验归属一致（跨租户 grant 无效）；
 * - 会话吊销 = revoked_at 置位 → 下一请求 401 PREVIEW_SESSION_REVOKED（无需等 15min 过期）；
 * - 预览会话默认只读（allowRealWrite 需发起时显式声明且响应标记）。
 */
@Service
public class PreviewGrantService {

    /** grant 有效期（04BE §A.7：5 分钟）。 */
    static final OffsetDateTime GRANT_TTL = null; // 占位防误用——见 grantExpiry()
    private static final java.time.Duration GRANT_DURATION = java.time.Duration.ofMinutes(5);
    private static final java.time.Duration SESSION_DURATION = java.time.Duration.ofMinutes(15);
    private static final long PREVIEW_ACCESS_TTL_SECONDS = 15 * 60;
    private static final SecureRandom RANDOM = new SecureRandom();

    private final PreviewGrantRepository grants;
    private final IamRepository iam;
    private final JwtCodec jwt;

    public PreviewGrantService(PreviewGrantRepository grants, IamRepository iam, JwtCodec jwt) {
        this.grants = grants;
        this.iam = iam;
        this.jwt = jwt;
    }

    @Autowired
    @Lazy
    private PreviewGrantService selfRef;

    // ---------- 签发（§A.7：仅应用开发者及以上；此处落地为持应用设计权限者） ----------

    @Transactional
    public Map<String, Object> issueGrant(long appId, Long pageId, boolean allowRealWrite) {
        TenantInfo tenant = TenantContext.get();
        assertPreviewPerm(tenant, appId);
        String grantUuid = UUID.randomUUID().toString();
        grants.insertGrant(tenant.tenantId(), appId, pageId, grantUuid, tenant.operatorId(),
                allowRealWrite, OffsetDateTime.now().plus(GRANT_DURATION));
        auditPreview(tenant, appId, pageId, "PREVIEW_GRANT_ISSUED", Map.of("grantId", grantUuid,
                "allowRealWrite", allowRealWrite));

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("grantId", grantUuid);
        resp.put("previewUrl", "/preview?grant=" + grantUuid);
        resp.put("expiresIn", 300);
        return resp;
    }

    // ---------- 兑换（§A.7：换取后 grant 立即失效） ----------

    @Transactional
    public Map<String, Object> exchange(String grantUuid) {
        Grant grant = grants.findGrant(grantUuid)
                .orElseThrow(BizException::grantConsumed);
        TenantInfo tenant = TenantContext.get();
        // 绑定约束：grant 归属租户一致（跨租户 grant 无效——同文案不给存在性线索）
        if (grant.tenantId() != tenant.tenantId()) {
            auditPreview(tenant, grant.appId(), grant.pageId(), "PREVIEW_GRANT_CROSS_TENANT",
                    Map.of("grantId", grantUuid));
            throw BizException.grantConsumed();
        }
        if (!grant.usable()) {
            throw BizException.grantConsumed();
        }
        // 一次性消费（并发交换恰一次成功；失败侧重放语义）
        if (!grants.consumeGrant(grantUuid)) {
            throw BizException.grantConsumed();
        }

        String sessionUuid = UUID.randomUUID().toString();
        grants.insertSession(grant.tenantId(), grant.appId(), grant.pageId(), sessionUuid,
                grant.id(), grant.issuerId(), grant.allowRealWrite(),
                OffsetDateTime.now().plus(SESSION_DURATION));
        auditPreview(tenant, grant.appId(), grant.pageId(), "PREVIEW_SESSION_CREATED",
                Map.of("sessionId", sessionUuid, "grantId", grantUuid));

        // accessToken 内嵌 previewSessionId claim（04BE §A.7：JTI 同值——网关按会话校验）
        String accessToken = jwt.issuePreview(grant.issuerId(), grant.tenantId(), sessionUuid,
                PREVIEW_ACCESS_TTL_SECONDS);
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("accessToken", accessToken);
        resp.put("refreshToken", null);
        resp.put("previewSessionId", sessionUuid);
        resp.put("appId", Long.toString(grant.appId()));
        if (grant.pageId() != null) {
            resp.put("pageId", Long.toString(grant.pageId()));
        }
        resp.put("allowRealWrite", grant.allowRealWrite());
        resp.put("expiresIn", (int) PREVIEW_ACCESS_TTL_SECONDS);
        return resp;
    }

    // ---------- 吊销闭环（§A.7） ----------

    /** 吊销该应用全部未用 grant 与全部在途会话（泄漏应急）。 */
    @Transactional
    public Map<String, Object> revokeAll(long appId) {
        TenantInfo tenant = TenantContext.get();
        assertPreviewPerm(tenant, appId);
        int revokedGrants = grants.revokeUnusedGrants(tenant.tenantId(), appId);
        int revokedSessions = grants.revokeSessionsOfApp(tenant.tenantId(), appId);
        auditPreview(tenant, appId, null, "PREVIEW_REVOKE_ALL",
                Map.of("revokedGrants", revokedGrants, "revokedSessions", revokedSessions));
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("revokedGrants", revokedGrants);
        resp.put("revokedSessions", revokedSessions);
        return resp;
    }

    /** 吊销单个在途预览会话（预览页「吊销」入口）。 */
    @Transactional
    public Map<String, Object> revokeSession(String sessionUuid) {
        TenantInfo tenant = TenantContext.get();
        Session session = grants.findSession(sessionUuid)
                .orElseThrow(() -> BizException.pageNotFound("预览会话"));
        if (session.tenantId() != tenant.tenantId()) {
            throw BizException.pageNotFound("预览会话");   // 跨租户同判不存在
        }
        grants.revokeSession(tenant.tenantId(), sessionUuid);
        auditPreview(tenant, session.appId(), session.pageId(), "PREVIEW_SESSION_REVOKED",
                Map.of("sessionId", sessionUuid));
        return Map.of();
    }

    /** 会话校验（JwtAuthFilter 预览态调用）：吊销/过期 → 401 PREVIEW_SESSION_REVOKED。 */
    public Session validateSession(String sessionUuid) {
        Session session = grants.findSession(sessionUuid).orElse(null);
        if (session == null || !session.active()) {
            throw BizException.previewSessionRevoked();
        }
        return session;
    }

    // ---------- 内部 ----------

    /** 预览权限闸门：发起人须为应用开发者及以上（MVP 落地为持应用设计权限或 org:manage）。 */
    private void assertPreviewPerm(TenantInfo tenant, long appId) {
        Long operatorId = tenant.operatorId();
        if (operatorId == null || operatorId <= 0) {
            throw BizException.permDenied();
        }
        UserAccount operator = iam.findUserById(operatorId).orElse(null);
        if (operator == null || operator.tenantId() != tenant.tenantId()) {
            throw BizException.permDenied();
        }
        List<Long> roleIds = iam.findRolesOfUser(tenant.tenantId(), operatorId).stream()
                .map(r -> (Number) r.get("id"))
                .filter(java.util.Objects::nonNull)
                .map(Number::longValue)
                .toList();
        if (roleIds.isEmpty()) {
            throw BizException.permDenied();
        }
        boolean granted = iam.findPermsOfRoles(roleIds).stream().anyMatch(p ->
                "action:org:manage".equals(p.toPermString())
                        || "action:preview:grant".equals(p.toPermString()));
        if (!granted) {
            throw BizException.permDenied();
        }
    }

    /** 预览访问审计（who/when/app/page——独立于常规访问日志，04BE §A.7）。 */
    private void auditPreview(TenantInfo tenant, Long appId, Long pageId, String reason,
            Map<String, Object> detail) {
        try {
            Map<String, Object> merged = new LinkedHashMap<>(detail);
            if (appId != null) {
                merged.put("appId", appId);
            }
            if (pageId != null) {
                merged.put("pageId", pageId);
            }
            iam.insertAudit("SENSITIVE_OP", tenant.tenantId(), tenant.operatorId(), "PAGE",
                    "preview", merged, null, null);
        } catch (Exception ignored) {
            // 审计失败不阻断凭证链路（登记失败不阻断保存同源口径）
        }
    }

    @SuppressWarnings("unused")
    private static String randomToken() {
        byte[] bytes = new byte[24];
        RANDOM.nextBytes(bytes);
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    @SuppressWarnings("unused")
    private static String json(Map<String, Object> m) {
        return Json.write(m);
    }
}
