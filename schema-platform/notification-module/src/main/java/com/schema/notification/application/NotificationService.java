package com.schema.notification.application;

import com.schema.notification.domain.NotifyPolicy;
import com.schema.notification.domain.repository.NotificationRepository;
import com.schema.platform.common.json.Json;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 通知服务（12BE §3 发送管线 / §5 频控 / §4 站内信查询）。
 * MVP 通道：INBOX 必达（其余通道 Phase 2 连接器接入——status DONE 即站内信完成）。
 */
@Service
public class NotificationService {

    private final NotificationRepository repo;

    public NotificationService(NotificationRepository repo) {
        this.repo = repo;
    }

    /**
     * 发送管线（12BE §3 ①-⑤）：偏好过滤 → 频控判定 → 模板渲染（失败降级可用性优先）→ 通道执行 → 落库。
     * 内部入口（服务端调用）；用户触发入口见 sendUser()。
     * SUPPRESS 留痕（12BE §5）：偏好关闭/频控超窗均落库 status='SUPPRESSED'（可审计"为什么没收到"）。
     */
    @Transactional
    public Map<String, Object> send(long tenantId, String bizType, String bizRefId, long recipientId,
            String templateKey, Map<String, Object> vars, String jumpUrl) {
        if (!NotifyPolicy.BIZ_TYPES.contains(bizType)) {
            throw new BizException("NOTIFY_BIZ_TYPE_INVALID", "非法业务类型: " + bizType);
        }

        // ① 偏好过滤（12BE §4）：bizType 级关闭整条 SUPPRESS；SECURITY_ALERT 不可关闭（安全红线）
        if (!"SECURITY_ALERT".equals(bizType) && prefDisabled(tenantId, recipientId, bizType)) {
            long id = repo.insert(tenantId, bizType, bizRefId, recipientId, templateKey,
                    NotifyPolicy.renderedJson(bizType, "", jumpUrl, false),
                    "[]", "SUPPRESSED", "USER_PREF_DISABLED", OffsetDateTime.now());
            return Map.of("id", Long.toString(id), "status", "SUPPRESSED", "reason", "USER_PREF_DISABLED");
        }

        // ② 频控（12BE §5）三级判定，SECURITY_ALERT 豁免——超窗 SUPPRESS 且留痕
        //    2a. 租户级护栏：单租户投递上限（跨 bizRef 跨用户合计，防刷屏穿透业务键维度）
        //    2b. 用户级兜底：单收件人单类型合计（跨 bizRef 合并——换业务键不绕过）
        //    2c. 业务键级：bizType:recipient:bizRef 精确窗口（同任务催办限频）
        if (!NotifyPolicy.unlimited(bizType)) {
            if (overTenantRate(tenantId)) {
                long id = repo.insert(tenantId, bizType, bizRefId, recipientId, templateKey,
                        NotifyPolicy.renderedJson(bizType, "", jumpUrl, false),
                        "[]", "SUPPRESSED", "TENANT_RATE_LIMITED", OffsetDateTime.now());
                return Map.of("id", Long.toString(id), "status", "SUPPRESSED", "reason", "TENANT_RATE_LIMITED");
            }
            int[] fallback = NotifyPolicy.USER_FALLBACK;
            String userKey = "rate:" + tenantId + ":user:" + recipientId + ":" + bizType;
            if (repo.bumpRate(userKey, fallback[0]) > fallback[1]) {
                long id = repo.insert(tenantId, bizType, bizRefId, recipientId, templateKey,
                        NotifyPolicy.renderedJson(bizType, "", jumpUrl, false),
                        "[]", "SUPPRESSED", "USER_RATE_LIMITED", OffsetDateTime.now());
                return Map.of("id", Long.toString(id), "status", "SUPPRESSED", "reason", "USER_RATE_LIMITED");
            }
            String rateKey = rateKey(tenantId, bizType, bizRefId, recipientId);
            int[] window = NotifyPolicy.rateWindowOf(bizType);
            if (repo.bumpRate(rateKey, window[0]) > window[1]) {
                long id = repo.insert(tenantId, bizType, bizRefId, recipientId, templateKey,
                        NotifyPolicy.renderedJson(bizType, "", jumpUrl, false),
                        "[]", "SUPPRESSED", "RATE_LIMITED", OffsetDateTime.now());
                return Map.of("id", Long.toString(id), "status", "SUPPRESSED", "reason", "RATE_LIMITED");
            }
        }

        // ③ 模板渲染（代码真源内置 → 租户自定义覆盖；缺模板降级裸标题可用性优先）
        Template tpl = resolveTemplate(tenantId, bizType, templateKey);
        NotifyPolicy.Rendered title = NotifyPolicy.render(tpl.title(), vars);
        NotifyPolicy.Rendered body = NotifyPolicy.render(tpl.body(), vars);
        boolean partial = title.partial() || body.partial();
        String renderedJson = NotifyPolicy.renderedJson(title.text(), body.text(), jumpUrl, partial);

        // ④ 通道执行：MVP 仅 INBOX（必达——写库即 DONE）；12BE §4 status=PARTIAL 语义随多通道接入
        String channelsJson = "[{\"channel\":\"INBOX\",\"status\":\"DONE\"}]";
        String status = "DONE";

        // ⑤ 落库
        long id = repo.insert(tenantId, bizType, bizRefId, recipientId, templateKey,
                renderedJson, channelsJson, status, null, OffsetDateTime.now());
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("id", Long.toString(id));
        resp.put("status", status);
        if (partial) {
            resp.put("partial", true);
        }
        return resp;
    }

    /** 站内信列表（12BE §4 §A.1：分页 + 未读过滤 + bizType 过滤——total 与 items 同条件）。 */
    public Map<String, Object> list(boolean unreadOnly, String bizType, int page, int size) {
        TenantInfo t = tenant();
        long total = repo.count(t.tenantId(), t.operatorId(), unreadOnly, bizType);
        List<Map<String, Object>> rows = repo.list(t.tenantId(), t.operatorId(), unreadOnly, bizType,
                Math.max(0, page), Math.min(50, Math.max(1, size)));
        List<Map<String, Object>> items = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            items.add(projection(row));
        }
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("total", total);
        resp.put("unread", repo.count(t.tenantId(), t.operatorId(), true));
        resp.put("items", items);
        return resp;
    }

    /** 未读数（12BE §A.2 unreadCount——轮询降级实现；长连接随 Phase 2 SSE）。 */
    public Map<String, Object> unreadCount() {
        TenantInfo t = tenant();
        return Map.of("unread", repo.count(t.tenantId(), t.operatorId(), true));
    }

    /** 单条已读（幂等：COALESCE 保留首次 read_at；收件人绑定——只能标记自己的消息）。 */
    @Transactional
    public Map<String, Object> markRead(long id) {
        TenantInfo t = tenant();
        repo.findById(t.tenantId(), id).orElseThrow(() -> new BizException("NOTIFY_NOT_FOUND", "消息不存在"));
        repo.markRead(t.tenantId(), t.operatorId(), id, OffsetDateTime.now());
        return Map.of("read", true);
    }

    /** 全部已读（12BE §A.1）。 */
    @Transactional
    public Map<String, Object> markAllRead() {
        TenantInfo t = tenant();
        int n = repo.markAllReadReturning(t.tenantId(), t.operatorId());
        return Map.of("updated", n);
    }

    /** 偏好读写（12BE §A.3）。 */
    public Map<String, Object> pref() {
        TenantInfo t = tenant();
        return repo.findPref(t.tenantId(), t.operatorId())
                .map(row -> Json.readMap(String.valueOf(row.get("prefs"))))
                .orElseGet(LinkedHashMap::new);
    }

    @Transactional
    public Map<String, Object> savePref(Map<String, Object> prefs) {
        TenantInfo t = tenant();
        repo.upsertPref(t.tenantId(), t.operatorId(), Json.write(prefs));
        return Map.of("saved", true);
    }

    // ---------- 内部 ----------

    private boolean prefDisabled(long tenantId, long userId, String bizType) {
        return repo.findPref(tenantId, userId)
                .map(row -> {
                    Map<String, Object> prefs = Json.readMap(String.valueOf(row.get("prefs")));
                    Object v = prefs.get(bizType);
                    return Boolean.FALSE.equals(v);
                })
                .orElse(false);
    }

    private String rateKey(long tenantId, String bizType, String bizRefId, long recipientId) {
        // 维度：bizType + bizRef（同一任务催办独立计数）+ 收件人
        return "rate:" + tenantId + ":" + bizType + ":" + (bizRefId == null ? "-" : bizRefId)
                + ":" + recipientId;
    }

    /** 租户级护栏（12BE §5「单租户投递上限」）：滑动窗口内租户合计投递数。 */
    private boolean overTenantRate(long tenantId) {
        int[] guard = NotifyPolicy.TENANT_GUARD;
        String tenantKey = "rate:" + tenantId + ":tenant";
        return repo.bumpRate(tenantKey, guard[0]) > guard[1];
    }

    private Template resolveTemplate(long tenantId, String bizType, String templateKey) {
        // 租户自定义优先 → 系统内置（12BE §3 ② 真源顺序）
        if (templateKey != null) {
            var custom = repo.findTemplate(tenantId, templateKey);
            if (custom.isPresent()) {
                Map<String, Object> row = custom.get();
                return new Template(templateKey, String.valueOf(row.get("title")),
                        String.valueOf(row.get("body")));
            }
            String[] builtin = NotifyPolicy.SYSTEM_TEMPLATES.get(templateKey);
            if (builtin != null) {
                return new Template(templateKey, builtin[0], builtin[1]);
            }
        }
        // 兜底：无模板裸业务类型（可用性优先——渲染永不阻塞发送）
        return new Template(null, bizType, "");
    }

    private Map<String, Object> projection(Map<String, Object> row) {
        Map<String, Object> rendered = Json.readMap(String.valueOf(row.get("rendered")));
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", String.valueOf(row.get("id")));
        m.put("bizType", row.get("biz_type"));
        m.put("bizRefId", row.get("biz_ref_id"));
        m.put("title", rendered.get("title"));
        m.put("body", rendered.get("body"));
        m.put("jumpUrl", rendered.get("jumpUrl"));
        m.put("partial", Boolean.TRUE.equals(rendered.get("partial")));
        m.put("read", row.get("read_at") != null);
        m.put("createdAt", String.valueOf(row.get("created_at")));
        return m;
    }

    private static TenantInfo tenant() {
        TenantInfo t = TenantContext.get();
        if (t == null) {
            throw BizException.unauthorized("租户上下文缺失");
        }
        return t;
    }

    private record Template(String key, String title, String body) {}
}
