package com.schema.data.application;

import com.schema.platform.common.web.BizException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 预览数据面安全边界（04BE §A.7 数据面收口，2026-10-30 修正）：
 * /api/data 仅靠路径前缀放行不够——本守卫在引擎入口逐请求拦截：
 *
 * 1. 写方法（POST/PUT/DELETE）默认拒绝 PREVIEW_WRITE_DENIED；
 *    会话 allowRealWrite=true 时放行（发起人显式声明的真实写预览）；
 * 2. 读方法限定模型范围：会话绑定 pageId 时，仅放行该页绑定的模型
 *    （page_schema.model_id）；应用级预览（pageId=null）放行全应用模型；
 * 3. 预览态无登录主体：引擎侧操作者取会话发起人（写入审计与 created_by 需要）。
 *
 * JwtAuthFilter 已保证预览 token 只能到 PREVIEW_ALLOWED_PATHS；本类是数据面第二道闸。
 * page_schema 直查（跨模块表依赖与 MetadataFieldReferenceAdapter 同口径——组合根背书）。
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

    /** 模型范围拦截：预览限页会话仅可访问该页绑定的模型（应用级预览不受限）。 */
    public void assertModelInPreviewScope(boolean preview, Long previewPageId, long modelId) {
        if (!preview || previewPageId == null) {
            return;
        }
        List<Long> bound = jdbc.query(
                "SELECT model_id FROM page_schema WHERE id=? AND status='ACTIVE'",
                (rs, i) -> rs.getObject(1) == null ? null : rs.getLong(1), previewPageId);
        Long modelBound = bound.isEmpty() ? null : bound.get(0);
        boolean allowed = modelBound != null && modelBound == modelId;
        if (!allowed) {
            throw new BizException("PREVIEW_SCOPE_DENIED",
                    "模型不在预览页面范围内: " + modelId);
        }
    }
}
