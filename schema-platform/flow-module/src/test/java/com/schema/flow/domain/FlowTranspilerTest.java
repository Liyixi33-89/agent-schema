package com.schema.flow.domain;

import com.schema.flow.domain.FlowDtos.DeptRoleApprover;
import com.schema.flow.domain.FlowDtos.FlowEdge;
import com.schema.flow.domain.FlowDtos.FlowNode;
import com.schema.flow.domain.FlowDtos.FlowSchema;
import com.schema.flow.domain.FlowDtos.UserApprover;
import com.schema.platform.common.web.BizException;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * FlowSchema 校验与 Transpiler 单测（spec 021 T3 覆盖要求）：
 * 七型中四型拒绝 + 三型编译通过，外加结构规则与转义的回归保护。
 */
class FlowTranspilerTest {

    private static FlowNode start() {
        return new FlowNode("s1", "START", "开始", null, null);
    }

    private static FlowNode approval() {
        return new FlowNode("a1", "APPROVAL", "主管审批", new UserApprover(List.of("7")), null);
    }

    private static FlowNode end() {
        return new FlowNode("e1", "END", "结束", null, null);
    }

    private static FlowSchema schema(FlowNode... nodes) {
        return new FlowSchema("leave", "请假流程", 1, 1, List.of(nodes), List.of());
    }

    private static FlowSchema linear() {
        return new FlowSchema("leave", "请假流程", 1, 1,
                List.of(start(), approval(), end()),
                List.of(new FlowEdge("f1", "s1", "a1", null),
                        new FlowEdge("f2", "a1", "e1", null)));
    }

    // ---------- Transpiler：三型编译通过 ----------

    @Test
    void transpilesLinearFlowToBpmn() {
        String xml = FlowTranspiler.transpile(linear());

        assertTrue(xml.contains("<startEvent id=\"s1\"/>"), "START → startEvent");
        assertTrue(xml.contains("<userTask id=\"a1\""), "APPROVAL → userTask");
        assertTrue(xml.contains("flowable:taskListener"), "审批人由 TaskListener 运行时解析");
        // assignee 必须留空——三模式实时解析，不能在定义期固定
        assertTrue(!xml.contains("flowable:assignee"), "assignee 不得在定义期固化");
        assertTrue(xml.contains("<endEvent id=\"e1\"/>"), "END → endEvent");
        assertTrue(xml.contains("sourceRef=\"s1\" targetRef=\"a1\""), "顺序流 s1→a1");
        assertTrue(xml.contains("sourceRef=\"a1\" targetRef=\"e1\""), "顺序流 a1→e1");
        assertTrue(xml.contains("id=\"leave\""), "process id 取 flowKey");
    }

    @Test
    void escapesUserSuppliedNames() {
        FlowSchema s = new FlowSchema("k&1", "含<尖括号>与\"引号\"", 1, 1,
                List.of(start(), end()),
                List.of(new FlowEdge("f1", "s1", "e1", null)));
        String xml = FlowTranspiler.transpile(s);

        assertTrue(xml.contains("&amp;"), "& 必须转义");
        assertTrue(xml.contains("&lt;尖括号&gt;"), "< > 必须转义");
        assertTrue(xml.contains("&quot;"), "引号必须转义");
    }

    // ---------- Transpiler/发布校验：四型拒绝 ----------

    @Test
    void rejectsEachUnsupportedNodeTypeOnPublish() {
        for (String type : List.of("CC", "CONDITION_BRANCH", "PARALLEL_GATEWAY", "MERGE_GATEWAY")) {
            FlowSchema s = new FlowSchema("f-" + type, "含不支持节点", 1, 1,
                    List.of(start(), new FlowNode("x1", type, "不支持", null, null), end()),
                    List.of(new FlowEdge("f1", "s1", "x1", null),
                            new FlowEdge("f2", "x1", "e1", null)));
            // 注意：结构上是合法的（连通、无环、START/END 齐备）
            FlowSchemaValidator.validateForSave(s);

            BizException e = assertThrows(BizException.class,
                    () -> FlowSchemaValidator.validateForPublish(s), type + " 必须被发布校验拒绝");
            assertEquals(FlowErrors.NODE_TYPE_NOT_SUPPORTED, e.code());
            @SuppressWarnings("unchecked")
            List<java.util.Map<String, Object>> nodes =
                    (List<java.util.Map<String, Object>>) e.details().get("nodes");
            assertEquals(1, nodes.size(), "逐节点定位");
            assertEquals("x1", nodes.get(0).get("nodeId"));
            assertEquals(type, nodes.get(0).get("type"));
        }
    }

    @Test
    void transpilerDefensivelyRejectsUnmappedNode() {
        // 绕过 validateForPublish 直接喂 Transpiler（防御层必须自己拦）
        FlowSchema s = new FlowSchema("bad", "非法", 1, 1,
                List.of(start(), new FlowNode("c1", "CC", "抄送", null, null), end()),
                List.of(new FlowEdge("f1", "s1", "c1", null),
                        new FlowEdge("f2", "c1", "e1", null)));

        BizException e = assertThrows(BizException.class, () -> FlowTranspiler.transpile(s));
        assertEquals(FlowErrors.NODE_TYPE_NOT_SUPPORTED, e.code());
    }

    // ---------- 结构校验：与前端同判的关键规则 ----------

    @Test
    void rejectsMultipleStarts() {
        FlowSchema s = new FlowSchema("k", "n", 1, 1,
                List.of(start(), new FlowNode("s2", "START", "另一个开始", null, null), end()),
                List.of(new FlowEdge("f1", "s1", "e1", null),
                        new FlowEdge("f2", "s2", "e1", null)));
        BizException e = assertThrows(BizException.class, () -> FlowSchemaValidator.validateForSave(s));
        assertEquals(FlowErrors.SCHEMA_INVALID, e.code());
        assertTrue(errorsOf(e).stream().anyMatch(x -> x.contains("START 节点必须恰好 1 个")));
    }

    @Test
    void rejectsMissingEnd() {
        FlowSchema s = new FlowSchema("k", "n", 1, 1,
                List.of(start(), new FlowNode("a1", "APPROVAL", "审批", new UserApprover(List.of("7")), null)),
                List.of(new FlowEdge("f1", "s1", "a1", null)));
        BizException e = assertThrows(BizException.class, () -> FlowSchemaValidator.validateForSave(s));
        assertTrue(errorsOf(e).stream().anyMatch(x -> x.contains("END 节点至少 1 个")));
    }

    @Test
    void rejectsUnreachableNode() {
        FlowSchema s = new FlowSchema("k", "n", 1, 1,
                List.of(start(), approval(), end(),
                        new FlowNode("orphan", "APPROVAL", "孤岛", new UserApprover(List.of("7")), null)),
                List.of(new FlowEdge("f1", "s1", "a1", null),
                        new FlowEdge("f2", "a1", "e1", null)));
        BizException e = assertThrows(BizException.class, () -> FlowSchemaValidator.validateForSave(s));
        assertTrue(errorsOf(e).stream().anyMatch(x -> x.contains("节点不可达")));
    }

    @Test
    void rejectsCycle() {
        FlowSchema s = new FlowSchema("k", "n", 1, 1,
                List.of(start(), approval(), end()),
                List.of(new FlowEdge("f1", "s1", "a1", null),
                        new FlowEdge("f2", "a1", "e1", null),
                        new FlowEdge("f3", "e1", "a1", null)));
        BizException e = assertThrows(BizException.class, () -> FlowSchemaValidator.validateForSave(s));
        assertTrue(errorsOf(e).stream().anyMatch(x -> x.contains("存在环路")));
    }

    @Test
    void rejectsSelfLoopAndDanglingEndpoint() {
        FlowSchema s = new FlowSchema("k", "n", 1, 1,
                List.of(start(), end()),
                List.of(new FlowEdge("f1", "s1", "s1", null),
                        new FlowEdge("f2", "s1", "ghost", null)));
        BizException e = assertThrows(BizException.class, () -> FlowSchemaValidator.validateForSave(s));
        List<String> errs = errorsOf(e);
        assertTrue(errs.stream().anyMatch(x -> x.contains("自环边禁止")));
        assertTrue(errs.stream().anyMatch(x -> x.contains("端点不存在")));
    }

    @Test
    void rejectsEmptyApproverUserList() {
        FlowSchema s = new FlowSchema("k", "n", 1, 1,
                List.of(start(), new FlowNode("a1", "APPROVAL", "审批", new UserApprover(List.of()), null), end()),
                List.of(new FlowEdge("f1", "s1", "a1", null),
                        new FlowEdge("f2", "a1", "e1", null)));
        BizException e = assertThrows(BizException.class, () -> FlowSchemaValidator.validateForSave(s));
        assertTrue(errorsOf(e).stream().anyMatch(x -> x.contains("USER 模式必填非空")));
    }

    @Test
    void acceptsDeptRoleApprover() {
        FlowSchema s = new FlowSchema("k", "n", 1, 1,
                List.of(start(), new FlowNode("a1", "APPROVAL", "审批",
                        new DeptRoleApprover(List.of("dept_manager")), null), end()),
                List.of(new FlowEdge("f1", "s1", "a1", null),
                        new FlowEdge("f2", "a1", "e1", null)));
        FlowSchemaValidator.validateForPublish(s);
    }

    @Test
    void rejectsUnknownNodeType() {
        FlowSchema s = new FlowSchema("k", "n", 1, 1,
                List.of(start(), new FlowNode("x", "NOT_A_TYPE", "非法", null, null), end()),
                List.of(new FlowEdge("f1", "s1", "x", null),
                        new FlowEdge("f2", "x", "e1", null)));
        BizException e = assertThrows(BizException.class, () -> FlowSchemaValidator.validateForSave(s));
        assertTrue(errorsOf(e).stream().anyMatch(x -> x.contains("未知节点类型")));
    }

    @Test
    void saveAllowsUnsupportedNodeButPublishRejects() {
        // 关键语义：草稿可以存含 CONDITION_BRANCH 的流程（后续阶段启用），发布必须拒
        FlowSchema s = new FlowSchema("k", "n", 1, 1,
                List.of(start(), new FlowNode("c1", "CONDITION_BRANCH", "分支", null, null), end()),
                List.of(new FlowEdge("f1", "s1", "c1", null),
                        new FlowEdge("f2", "c1", "e1", null)));
        FlowSchemaValidator.validateForSave(s);
        assertThrows(BizException.class, () -> FlowSchemaValidator.validateForPublish(s));
    }

    @SuppressWarnings("unchecked")
    private static List<String> errorsOf(BizException e) {
        return (List<String>) e.details().get("errors");
    }
}