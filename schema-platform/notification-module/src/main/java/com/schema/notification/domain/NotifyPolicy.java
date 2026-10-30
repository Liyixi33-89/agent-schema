package com.schema.notification.domain;

import com.schema.platform.common.json.Json;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 通知域常量与频控策略（12BE §3/§5）。
 * MVP 只交付站内信通道（INBOX 必达）；IM/EMAIL/SMS 随 Phase 2 连接器接入。
 */
public final class NotifyPolicy {

    private NotifyPolicy() {}

    /** 业务类型白名单（12BE §2 biz_type）。 */
    public static final java.util.Set<String> BIZ_TYPES = java.util.Set.of(
            "FLOW_TODO", "FLOW_DONE", "FLOW_URGE", "QUOTA_WARN", "SECURITY_ALERT", "APP_NOTICE", "CUSTOM");

    /** 频控窗口（12BE §5：超窗即 SUPPRESS）。 */
    public static final Map<String, int[]> RATE_WINDOWS = Map.of(
            // bizType -> [窗口秒, 次数上限]
            "FLOW_URGE", new int[]{3600, 1},          // 1 次/小时/任务
            "QUOTA_WARN", new int[]{86400, 1},        // 1 次/天/指标
            "APP_NOTICE", new int[]{86400, 10});      // 兜底 10 条/天/租户

    /** SECURITY_ALERT 不限频（安全告警宁可重复）；未声明的 CUSTOM 走默认兜底。 */
    public static int[] rateWindowOf(String bizType) {
        return RATE_WINDOWS.getOrDefault(bizType, new int[]{3600, 10});
    }

    public static boolean unlimited(String bizType) {
        return "SECURITY_ALERT".equals(bizType);
    }

    /** 系统内置模板（12BE §3 首版 12 个——代码真源，不入库）。 */
    public static final Map<String, String[]> SYSTEM_TEMPLATES = buildSystemTemplates();

    private static Map<String, String[]> buildSystemTemplates() {
        Map<String, String[]> m = new LinkedHashMap<>();
        m.put("FLOW_TODO_APPROVE", new String[]{"待审批：{{flowName}}", "您有一条来自 {{flowName}} 的待办（单号 {{bizRef}}），请及时处理。"});
        m.put("FLOW_TODO_TIMEOUT", new String[]{"审批超时预警：{{flowName}}", "流程 {{flowName}}（{{bizRef}}）即将超时，请尽快审批。"});
        m.put("FLOW_URGE", new String[]{"催办：{{flowName}}", "{{sender}} 催促您处理 {{flowName}}（{{bizRef}}）。"});
        m.put("FLOW_DONE_APPROVED", new String[]{"已通过：{{flowName}}", "您发起的 {{flowName}}（{{bizRef}}）已审批通过。"});
        m.put("FLOW_DONE_REJECTED", new String[]{"已驳回：{{flowName}}", "您发起的 {{flowName}}（{{bizRef}}）被驳回，请查看意见。"});
        m.put("FLOW_AGENT_ERROR", new String[]{"流程死信：{{flowName}}", "流程 {{flowName}}（{{bizRef}}）执行异常进入死信，需人工介入。"});
        m.put("QUOTA_SOFT", new String[]{"配额预警：{{metric}}", "指标 {{metric}} 已用 {{used}}/{{limit}}，超过 80%。"});
        m.put("QUOTA_HARD", new String[]{"配额已满：{{metric}}", "指标 {{metric}} 已达上限 {{limit}}，操作被拦截。"});
        m.put("USAGE_SPIKE", new String[]{"用量突增", "租户 {{tenant}} 指标 {{metric}} 环比突增 {{pct}}%，请关注。"});
        m.put("APP_RELEASED", new String[]{"应用已发布", "应用 {{appName}} 已发布新版本 v{{version}}。"});
        m.put("APP_TEMPLATE_INSTALLED", new String[]{"模板已安装", "模板 {{templateName}} 安装完成。"});
        m.put("SECURITY_SENSITIVE_OP", new String[]{"安全告警：敏感操作", "账号 {{account}} 执行了敏感操作 {{op}}，若非本人请立即处理。"});
        return java.util.Collections.unmodifiableMap(m);
    }

    /**
     * 渲染占位符（12BE §3 ③：求值失败 → '--' + partial 标记，消息照发可用性优先）。
     * 模板表达式走 L1 求值器（与 08FE/01 同引擎，12BE §3「同一套 AST 白名单」）：
     * 占位符内允许白名单函数与字段访问（如 {{ UPPER(flowName) }}），编译/求值失败统一占位降级。
     */
    public static Rendered render(String template, Map<String, Object> vars) {
        StringBuilder out = new StringBuilder();
        boolean partial = false;
        int i = 0;
        while (i < template.length()) {
            int start = template.indexOf("{{", i);
            if (start < 0) {
                out.append(template, i, template.length());
                break;
            }
            int end = template.indexOf("}}", start);
            if (end < 0) {
                out.append(template, i, template.length());
                break;
            }
            out.append(template, i, start);
            String expr = template.substring(start + 2, end).trim();
            String value = evalExpr(expr, vars);
            if (value == null) {
                out.append("--");   // 占位降级（12BE §3 ③）
                partial = true;
            } else {
                out.append(value);
            }
            i = end + 2;
        }
        return new Rendered(out.toString(), partial);
    }

    /** L1 求值（12BE §3 ② 受限解释器——白名单函数/字段访问，禁网络/文件/循环）。
     *  失败（编译错/字段缺失/预算超限）统一 null → 占位降级。纯标识符快路径不走引擎。 */
    private static String evalExpr(String expr, Map<String, Object> vars) {
        if (expr.isEmpty()) {
            return null;
        }
        // 快路径：纯标识符（含点号嵌套）直接取值——零引擎开销
        if (expr.matches("[a-zA-Z_][a-zA-Z0-9_]*(\\.[a-zA-Z_][a-zA-Z0-9_]*)*")) {
            return resolveVar(expr, vars);
        }
        try {
            com.schema.protocol.expr.ExprEngine.Node ast = com.schema.protocol.expr.ExprEngine.compile(expr);
            com.schema.protocol.expr.ExprEngine.EvalResult r =
                    com.schema.protocol.expr.ExprEngine.evaluate(ast, vars == null ? Map.of() : vars);
            if (r.error() != null || r.value() == null) {
                return null;
            }
            return String.valueOf(r.value());
        } catch (Exception e) {
            return null;
        }
    }

    /** 嵌套 Map 取值（纯标识符快路径；字段缺失返回 null）。 */
    private static String resolveVar(String expr, Map<String, Object> vars) {
        if (vars == null) return null;
        Object current = vars;
        for (String seg : expr.split("\\.")) {
            if (!(current instanceof Map<?, ?> m)) return null;
            current = m.get(seg);
        }
        return current == null ? null : String.valueOf(current);
    }

    public record Rendered(String text, boolean partial) {}

    /** 渲染快照 JSON（12BE §2 rendered 列结构）。 */
    public static String renderedJson(String title, String body, String jumpUrl, boolean partial) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("title", title);
        m.put("body", body);
        m.put("jumpUrl", jumpUrl);
        m.put("partial", partial);
        return Json.write(m);
    }
}
