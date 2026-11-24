package com.schema.flow.domain;

import com.schema.flow.domain.FlowDtos.FlowEdge;
import com.schema.flow.domain.FlowDtos.FlowNode;
import com.schema.flow.domain.FlowDtos.FlowSchema;
import com.schema.platform.common.web.BizException;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * FlowSchema → BPMN 2.0 XML 最小映射（spec 021 §2 第 4 条 / T3）。
 *
 * 映射表（本期仅三型）：
 * <pre>
 *   START    → startEvent
 *   APPROVAL → userTask（flowable:assignee 留空——由 TaskListener 运行时按三模式解析）
 *   END      → endEvent
 * </pre>
 *
 * 为什么手写 XML 而不是用 flowable-bpmn-model 的 BpmnXMLConverter：
 * 本期拓扑固定（START→APPROVAL×1→END，无网关/无条件表达式/无多实例），
 * 手写产物可读、可断言、零额外 API 依赖；后续阶段扩展网关时再切 DSL 构建器，
 * 届时本类的调用面（transpile 签名）不变。
 *
 * ⚠️ 拒绝语义：非本期支持节点**必须先被 {@link FlowSchemaValidator#validateForPublish} 拦下**；
 * 本方法再兜一层（防御），确保不会有未映射节点悄悄落进 BPMN 导致部署后才报错。
 */
public final class FlowTranspiler {

    /** 流程定义 key 在 BPMN 中的占位（部署时由 service 以 flowKey 覆盖）。 */
    private static final String PROCESS_KEY_PLACEHOLDER = "__FLOW_KEY__";

    private FlowTranspiler() {
    }

    /**
     * 生成 BPMN XML。
     *
     * @throws BizException NODE_TYPE_NOT_SUPPORTED（含未映射节点——防御性兜底）
     */
    public static String transpile(FlowSchema schema) {
        List<FlowNode> nodes = schema.nodes() == null ? List.of() : schema.nodes();
        List<FlowEdge> edges = schema.edges() == null ? List.of() : schema.edges();

        // 防御：非本期支持节点直接拒绝（正常链路已被发布校验拦下）
        List<Map<String, Object>> unsupported = new ArrayList<>();
        for (FlowNode n : nodes) {
            if (n == null || !SupportedNodeTypes.isSupported(n.type())) {
                Map<String, Object> d = new LinkedHashMap<>();
                d.put("nodeId", n == null ? null : n.id());
                d.put("type", n == null ? null : n.type());
                unsupported.add(d);
            }
        }
        if (!unsupported.isEmpty()) {
            throw new BizException(FlowErrors.NODE_TYPE_NOT_SUPPORTED,
                    "Transpiler 收到未映射的节点类型（本期仅 START/APPROVAL/END）",
                    Map.of("nodes", unsupported));
        }

        String processKey = isBlank(schema.flowKey()) ? PROCESS_KEY_PLACEHOLDER : schema.flowKey();
        String processName = isBlank(schema.name()) ? processKey : escape(schema.name());

        StringBuilder xml = new StringBuilder(1024);
        xml.append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
           .append("<definitions xmlns=\"http://www.omg.org/spec/BPMN/20100524/MODEL\"\n")
           .append("             xmlns:flowable=\"http://flowable.org/bpmn\"\n")
           .append("             targetNamespace=\"http://schema.com/flow\">\n")
           .append("  <process id=\"").append(escape(processKey))
           .append("\" name=\"").append(processName).append("\" isExecutable=\"true\">\n");

        for (FlowNode n : nodes) {
            switch (n.type()) {
                case "START" -> xml.append("    <startEvent id=\"").append(escape(n.id())).append("\"/>\n");
                case "APPROVAL" -> {
                    // ⚠️ 必须用 delegateExpression 而非 class：
                    //    class="..." 由引擎反射 new 实例，拿不到 Spring 依赖
                    //    （实测报 couldn't instantiate class → 发起直接失败）。
                    //    approverTaskListener 是 Spring bean 名（ApproverTaskListener @Component）
                    xml.append("    <userTask id=\"").append(escape(n.id()))
                       .append("\" name=\"").append(escape(nameOf(n))).append("\">\n")
                       .append("      <extensionElements>\n")
                       .append("        <flowable:taskListener event=\"create\" ")
                       .append("delegateExpression=\"${approverTaskListener}\"/>\n")
                       .append("      </extensionElements>\n")
                       .append("    </userTask>\n");
                }
                case "END" -> xml.append("    <endEvent id=\"").append(escape(n.id())).append("\"/>\n");
                default -> throw new BizException(FlowErrors.NODE_TYPE_NOT_SUPPORTED,
                        "Transpiler 未映射节点类型: " + n.type(),
                        Map.of("nodeId", n.id(), "type", n.type()));
            }
        }

        for (FlowEdge e : edges) {
            if (e == null) {
                continue;
            }
            xml.append("    <sequenceFlow id=\"").append(escape(e.id()))
               .append("\" sourceRef=\"").append(escape(e.from()))
               .append("\" targetRef=\"").append(escape(e.to())).append("\"/>\n");
        }

        xml.append("  </process>\n</definitions>\n");
        return xml.toString();
    }

    /** 生成部署用字节（UTF-8）。 */
    public static byte[] transpileBytes(FlowSchema schema) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] body = transpile(schema).getBytes(StandardCharsets.UTF_8);
        out.write(body, 0, body.length);
        return out.toByteArray();
    }

    private static String nameOf(FlowNode n) {
        return isBlank(n.name()) ? n.id() : n.name();
    }

    /** XML 文本转义（&、<、>、引号）——流程名/节点名可能含用户输入。 */
    private static String escape(String s) {
        if (s == null) {
            return "";
        }
        return s.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;");
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }
}