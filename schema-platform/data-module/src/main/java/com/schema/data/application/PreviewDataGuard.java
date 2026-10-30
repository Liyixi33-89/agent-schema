package com.schema.data.application;

import com.schema.platform.common.tenant.PreviewContext;
import com.schema.platform.common.web.BizException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 预览数据面安全边界（04BE §A.7 数据面收口，2026-10-30 二轮修正）：
 * /api/data 仅靠路径前缀放行不够——本守卫在引擎入口逐请求拦截：
 *
 * 1. 写方法（POST 根/PUT/DELETE）默认拒绝 PREVIEW_WRITE_DENIED；
 *    会话 allowRealWrite=true 时放行（发起人显式声明的真实写预览）；
 * 2. 读方法模型范围：
 *    - 限页会话（pageId≠null）：页绑定模型 ∪ 页发布快照 modelRefs（draft 场景退化 draft.modelId）；
 *    - 应用级预览（pageId=null）：模型归属会话应用（meta_model.app_id）——不放行全租户模型；
 * 3. 预览态无登录主体：引擎侧操作者取会话发起人（写入审计与 created_by 需要）。
 *
 * JwtAuthFilter 已保证预览 token 只能到预览端点白名单；本类是数据面第二道闸。
 * page_schema / meta_model 直查（跨模块表依赖与 MetadataFieldReferenceAdapter 同口径——组合根背书）。
 */
@Component
public class PreviewDataGuard {

    private final JdbcTemplate jdbc;

    public PreviewDataGuard(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 写方法拦截：非 allowRealWrite 会话的写操作一律 403。 */
    public void assertWriteAllowed(boolean preview, boolean allowRealWrite) {
        if (preview && !allowRealWrite) {
            throw new BizException("PREVIEW_WRITE_DENIED",
                    "预览会话为只读，真实写入需发起时显式声明 allowRealWrite");
        }
    }

    /**
     * 模型范围拦截：预览会话仅可访问范围内模型。
     * 限页 → 页绑定模型 ∪ 发布快照 modelRefs；应用级 → 应用内模型。
     * 全部查询带租户条件（会话租户外页面/模型同判越界）。
     */
    public void assertModelInPreviewScope(boolean preview, Long previewAppId, Long previewPageId,
            long tenantId, long modelId) {
        if (!preview) {
            return;
        }
        boolean allowed;
        if (previewPageId != null) {
            allowed = pageBoundModels(tenantId, previewPageId).contains(modelId);
        } else if (previewAppId != null) {
            Long belongs = jdbc.query(
                    "SELECT app_id FROM meta_model WHERE id=? AND tenant_id=? AND status='ACTIVE'",
                    (rs, i) -> rs.getLong(1), modelId, tenantId).stream().findFirst().orElse(null);
            allowed = belongs != null && belongs.longValue() == previewAppId;
        } else {
            // 无页面也无应用上下文（内部调用/测试兜底）：不放行
            allowed = false;
        }
        if (!allowed) {
            throw new BizException("PREVIEW_SCOPE_DENIED",
                    "模型不在预览范围内: " + modelId);
        }
    }

    /** 页面可访问模型集：绑定模型 + 发布快照 modelRefs；未发布页退化 draft.modelId。 */
    private Set<Long> pageBoundModels(long tenantId, long pageId) {
        Set<Long> models = new HashSet<>();
        List<String> rows = jdbc.query(
                "SELECT model_id, published::text AS published_text FROM page_schema "
                        + "WHERE id=? AND tenant_id=? AND status='ACTIVE'",
                (rs, i) -> {
                    Object mid = rs.getObject(1);
                    if (mid instanceof Number n) {
                        models.add(n.longValue());
                    }
                    return rs.getString(2);
                }, pageId, tenantId);
        String publishedText = rows.isEmpty() ? null : rows.get(0);
        if (publishedText != null && !publishedText.isBlank()) {
            collectModelRefs(publishedText, models);
        }
        return models;
    }

    /** 从发布快照 JSON 中提取 modelRefs 数组（快照自包含，含应用内全部页面模型引用）。 */
    private void collectModelRefs(String snapshotJson, Set<Long> sink) {
        try {
            com.google.gson.JsonArray refs = com.schema.platform.common.json.Json
                    .parseObject(snapshotJson).getAsJsonArray("modelRefs");
            if (refs == null) {
                return;
            }
            for (var el : refs) {
                try {
                    sink.add(el.getAsLong());
                } catch (ClassCastException | IllegalStateException ignored) {
                    // 非数值引用项跳过（快照结构防御——不影响放行集计算）
                }
            }
        } catch (Exception ignored) {
            // 快照结构异常：仅依赖绑定模型列（保守放行）
        }
    }
}
