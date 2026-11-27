package com.schema.bootstrap;

import com.schema.data.application.DynamicQueryEngine;
import com.schema.flow.application.RecordAccessPort;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.regex.Pattern;

/**
 * 业务记录访问校验适配器（2026-11-27 授权缺口修复）。
 *
 * ## 实现策略：复用数据面既有的行级权限，不另造一套
 * {@link DynamicQueryEngine#getById(long, long)} 的 SQL 已经包含三重约束：
 * ```sql
 * WHERE tenant_id = ? AND deleted_at IS NULL AND id = ? AND (<行级 scope>)
 * ```
 * 记录不存在、已删除、不在当前用户数据范围内 —— 三者同判「不存在」
 * （抛 {@code RECORD_NOT_FOUND}）。这正好就是「能不能碰这条记录」的判定，
 * 无需在流程侧重新实现权限逻辑（重复实现必然漂移）。
 *
 * ## 为什么把异常翻译成 false
 * 端口契约是布尔（可访问/不可访问），而引擎用异常表达。这里统一翻译，
 * 且**吞掉异常细节**——上层不需要区分「不存在」与「无权限」（也正是不该区分：
 * 差异会让攻击者探测他人记录是否存在）。
 *
 * 但**基础设施异常必须上抛**：数据库连不上不是「无权限」，
 * 静默转成 false 会把系统故障伪装成权限拒绝，排查会跑偏。
 */
@Component
public class RecordAccessAdapter implements RecordAccessPort {

    private static final Logger log = LoggerFactory.getLogger(RecordAccessAdapter.class);

    /** 引擎「记录不存在」的错误码（含不可见）。 */
    private static final Pattern NOT_FOUND_CODE =
            Pattern.compile("RECORD_NOT_FOUND|NOT_FOUND", Pattern.CASE_INSENSITIVE);

    private final DynamicQueryEngine engine;

    /**
     * 是否启用记录级授权（默认启用）。
     *
     * ⚠️ 关闭开关**只给集成测试用**：FlowIT 等用固定假 recordId（7001/7002…）
     * 验证引擎状态机，没有真实业务表数据。生产环境必须保持 true——
     * 关闭等于允许对任意（甚至不存在的）记录发起流程。
     *
     * 命名带 {@code flow.} 前缀是为了一眼看出属于流程域，避免被误当通用开关。
     */
    private final boolean enabled;

    public RecordAccessAdapter(DynamicQueryEngine engine,
            @org.springframework.beans.factory.annotation.Value(
                    "${flow.record-access.enabled:true}") boolean enabled) {
        this.engine = engine;
        this.enabled = enabled;
        if (!enabled) {
            log.warn("⚠️ flow.record-access.enabled=false：记录级授权已关闭（仅限集成测试）");
        }
    }

    @Override
    public boolean canAccess(long tenantId, long userId, long modelId, long recordId) {
        if (!enabled) {
            return true;   // 仅集成测试：引擎状态机验证不关心业务记录是否存在
        }
        // tenantId/userId 由引擎从 TenantContext 读取（与请求上下文一致）；
        // 这里显式传参是为了让端口契约完整，且便于将来支持「代他人判定」。
        try {
            engine.getById(modelId, recordId);
            return true;
        } catch (RuntimeException e) {
            String code = extractCode(e);
            if (code != null && NOT_FOUND_CODE.matcher(code).find()) {
                // 不存在 / 已删除 / 不在数据范围 —— 统一视为不可访问
                log.debug("记录不可访问 model={} record={} operator={} code={}",
                        modelId, recordId, userId, code);
                return false;
            }
            // 其余异常（DB 故障、SQL 错误）不是权限问题，上抛让调用方 fail-closed 并留痕
            throw e;
        }
    }

    /** 从异常链里找业务错误码（BizException 带 code；包装异常逐层解）。 */
    private static String extractCode(Throwable e) {
        for (Throwable cur = e; cur != null; cur = cur.getCause()) {
            String name = cur.getClass().getSimpleName();
            if ("BizException".equals(name)) {
                try {
                    Object v = cur.getClass().getMethod("code").invoke(cur);
                    if (v != null) return String.valueOf(v);
                } catch (ReflectiveOperationException ignored) {
                    // 拿不到 code 方法就走下面的 message 兜底
                }
                return cur.getMessage();
            }
            if (cur.getCause() == cur) break;
        }
        return null;
    }
}