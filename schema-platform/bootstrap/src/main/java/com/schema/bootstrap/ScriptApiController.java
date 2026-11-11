package com.schema.bootstrap;

import com.schema.data.application.DynamicQueryEngine;
import com.schema.data.domain.engine.SqlBuilder;
import com.schema.platform.common.tenant.PreviewContext;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.web.BizException;
import jakarta.servlet.http.HttpServletRequest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * L2 脚本 api.call 注册名代理（08FE §5：不接受 URL——注册名 → 固定模板，权限由数据引擎
 * 按调用者会话执行；Worker 不持 token，请求经宿主消息桥带用户 Cookie 到达此处）。
 *
 * 注册表（P1 固定最小集；扩展走安全评审 + 本表登记——与前端 BRIDGE_OPS 同纪律）：
 * - expense-records：报销登记列表（只读 query，page/size 受引擎上限约束）
 *
 * 安全口径：
 * - 只读（无注册写操作——写路径必须走表单提交链路的校验/权限/审计）；
 * - filter 不透传客户端过滤树（防过滤树注入探测越权行），仅允许 page/size 分页参数；
 * - 数据引擎 query 自带租户过滤 + 行级权限 + 字段权限（02BE §3.1——前端隔离不可信，
 *   服务端拦是唯一可信边界）。
 */
@RestController
public class ScriptApiController {

    private final DynamicQueryEngine engine;

    public ScriptApiController(DynamicQueryEngine engine) {
        this.engine = engine;
    }

    /** 注册名清单（设计器测试台提示用；不含敏感信息）。 */
    @GetMapping("/api/scripts/apis")
    public Map<String, Object> registry() {
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("names", List.of("expense-records"));
        return resp;
    }

    /**
     * GET /api/scripts/apis/{name}?params={"page":1,"size":20}
     * params 为 JSON 对象（前端 ctx.api.call(name, params) 透传）；仅接受 page/size 分页键，
     * 其余键忽略（不透传 filter/sorts/fields——防过滤树注入探测越权行）。
     * 预览上下文绑定与 DataController 同模板（预览态走只读——引擎侧 PreviewDataGuard 二次判定）。
     */
    @GetMapping("/api/scripts/apis/{name}")
    public Map<String, Object> call(@PathVariable String name, HttpServletRequest request) {
        Map<String, Object> params = parseParams(request.getParameter("params"));
        int page = intParam(params.get("page"), 1, 1, 10_000);
        int size = intParam(params.get("size"), 20, 1, 200);

        return withPreviewContext(request, () -> {
            long modelId = resolveModelId(name);
            SqlBuilder.QueryRequest req = new SqlBuilder.QueryRequest(
                    modelId, null, null, page, size, null, 0, false);
            return engine.query(req);
        });
    }

    /** 注册名 → modelId 解析（固定映射——不接受客户端指定 modelId）。 */
    private static long resolveModelId(String name) {
        TenantContext.get(); // 断言登录态（401 由过滤器承担，此处确保上下文存在）
        return switch (name) {
            case "expense-records" -> 1L; // 报销登记模型（验收环境固定 id 1）
            default -> throw new BizException("API_NOT_REGISTERED",
                    "脚本 API 未注册: " + name);
        };
    }

    /** params JSON 解析（畸形输入按空对象处理——拒绝放行为缺省分页即可，无需报错）。 */
    private static Map<String, Object> parseParams(String raw) {
        if (raw == null || raw.isBlank()) return Map.of();
        try {
            Object parsed = com.schema.platform.common.json.Json.readMap(raw);
            if (parsed instanceof Map<?, ?> m) {
                @SuppressWarnings("unchecked")
                Map<String, Object> typed = (Map<String, Object>) m;
                return typed;
            }
        } catch (Exception ignored) {
            // 畸形 params 按空对象处理
        }
        return Map.of();
    }

    private static int intParam(Object raw, int dflt, int min, int max) {
        if (raw instanceof Number n) {
            return Math.min(Math.max(n.intValue(), min), max);
        }
        if (raw instanceof String s && !s.isBlank()) {
            try {
                return Math.min(Math.max(Integer.parseInt(s.trim()), min), max);
            } catch (NumberFormatException ignored) {
                // 非数字按缺省
            }
        }
        return dflt;
    }

    /** 预览上下文绑定模板（与 DataController 同构——04BE §A.7）。 */
    private static <T> T withPreviewContext(HttpServletRequest request,
            java.util.function.Supplier<T> body) {
        Boolean preview = (Boolean) request.getAttribute("auth.preview");
        boolean isPreview = Boolean.TRUE.equals(preview);
        Object pageId = request.getAttribute("auth.previewPageId");
        Object allowWrite = request.getAttribute("auth.previewAllowRealWrite");
        Object appId = request.getAttribute("auth.previewAppId");
        try {
            PreviewContext.bind(isPreview,
                    appId instanceof Number n ? n.longValue() : null,
                    pageId instanceof Number n2 ? n2.longValue() : null,
                    allowWrite instanceof Boolean b ? b : null);
            return body.get();
        } finally {
            PreviewContext.clear();
        }
    }
}

/**
 * 脚本 API 域异常映射（与各模块 advice 同构——包限定不竞争）：
 * API_NOT_REGISTERED → 422；引擎透传错误按 DataExceptionHandler 语义映射。
 */
@RestControllerAdvice(basePackages = "com.schema.bootstrap")
class ScriptApiExceptionHandler {

    @ExceptionHandler(BizException.class)
    public ResponseEntity<Map<String, Object>> biz(BizException e) {
        HttpStatus status = switch (e.code()) {
            case "API_NOT_REGISTERED" -> HttpStatus.UNPROCESSABLE_ENTITY;
            case "RECORD_NOT_FOUND" -> HttpStatus.NOT_FOUND;
            case "PERM_DENIED", "PREVIEW_SCOPE_DENIED" -> HttpStatus.FORBIDDEN;
            default -> HttpStatus.BAD_REQUEST;
        };
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", e.code());
        body.put("message", e.getMessage());
        body.put("traceId", UUID.randomUUID().toString());
        return ResponseEntity.status(status).body(body);
    }
}
