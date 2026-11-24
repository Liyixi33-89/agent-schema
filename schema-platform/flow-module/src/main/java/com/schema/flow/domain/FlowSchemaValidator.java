package com.schema.flow.domain;

import com.schema.flow.domain.FlowDtos.ApproverRule;
import com.schema.flow.domain.FlowDtos.DeptRoleApprover;
import com.schema.flow.domain.FlowDtos.FlowEdge;
import com.schema.flow.domain.FlowDtos.FlowNode;
import com.schema.flow.domain.FlowDtos.FlowSchema;
import com.schema.flow.domain.FlowDtos.InitiatorSupervisorApprover;
import com.schema.flow.domain.FlowDtos.UserApprover;
import com.schema.platform.common.web.BizException;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * FlowSchema 结构校验（spec 021 T3 / §3.1「复用前端 validateFlowSchema 同构逻辑」）。
 *
 * 双端同判：前端 {@code validateFlowSchema}（schema-protocol/validate.ts）判定规则在此
 * 逐条镜像——前端拦下的一律拦下，前端放行的不额外加严（否则双端漂移会产生
 * 「设计器能存、后端拒保存」的矛盾）。差异点只有一处且是本 spec 明确要求的新增：
 * <b>本期节点集白名单</b>（发布期校验，见 {@link #validateForPublish}），保存期不做，
 * 以便用户存下含 CONDITION_BRANCH 的草稿、待后续阶段启用。
 *
 * 结构规则（与前端一一对应）：
 * 1. 顶层必填：flowKey/name/schemaVersion/nodes 非空/edges 为数组
 * 2. 节点：id 必填唯一、type 属七型、approver 模式属三模式且各模式必填项非空
 * 3. 边：id 必填唯一、端点存在、禁止自环
 * 4. START 恰好 1 个、END 至少 1 个
 * 5. 连通性：START 出发可达全部节点
 * 6. 全图无环（阶段 A 只读语义；回退边属 B 阶段扩展）
 */
public final class FlowSchemaValidator {

    private FlowSchemaValidator() {
    }

    /**
     * 结构校验（保存草稿时使用——不含本期节点集白名单）。
     *
     * @throws BizException code=FLOW_SCHEMA_INVALID，details.errors 为逐条错误
     */
    public static void validateForSave(FlowSchema schema) {
        List<String> errors = collectStructuralErrors(schema);
        if (!errors.isEmpty()) {
            throw schemaInvalid(errors);
        }
    }

    /**
     * 发布校验 = 结构校验 + 本期节点集白名单（spec 021 §2 第 2 条 / A7）。
     *
     * @throws BizException code=FLOW_SCHEMA_INVALID（结构问题）
     *                     或 NODE_TYPE_NOT_SUPPORTED（含本期不支持节点，逐节点定位）
     */
    public static void validateForPublish(FlowSchema schema) {
        validateForSave(schema);

        List<Map<String, Object>> unsupported = new ArrayList<>();
        for (FlowNode node : schema.nodes()) {
            if (!SupportedNodeTypes.isSupported(node.type())) {
                Map<String, Object> detail = new LinkedHashMap<>();
                detail.put("nodeId", node.id());
                detail.put("nodeName", node.name());
                detail.put("type", node.type());
                unsupported.add(detail);
            }
        }
        if (!unsupported.isEmpty()) {
            throw new BizException(FlowErrors.NODE_TYPE_NOT_SUPPORTED,
                    "流程含本期不支持的节点类型（本期仅支持 START/APPROVAL/END）",
                    Map.of("nodes", unsupported));
        }
    }

    /** 收集全部结构错误（不短路——一次返回全部，便于设计器逐节点标红）。 */
    public static List<String> collectStructuralErrors(FlowSchema schema) {
        List<String> errs = new ArrayList<>();
        if (schema == null) {
            return List.of("/: 流程结构必填");
        }
        if (isBlank(schema.flowKey())) {
            errs.add("/flowKey: 必填");
        }
        if (isBlank(schema.name())) {
            errs.add("/name: 必填");
        }
        if (schema.schemaVersion() == null) {
            errs.add("/schemaVersion: 必须为数字");
        }
        if (schema.nodes() == null || schema.nodes().isEmpty()) {
            errs.add("/nodes: 非空必填");
        }
        if (schema.edges() == null) {
            errs.add("/edges: 必须为数组");
        }
        if (!errs.isEmpty()) {
            return errs;
        }

        Set<String> nodeIds = new HashSet<>();
        Map<String, String> nodeType = new HashMap<>();
        for (int i = 0; i < schema.nodes().size(); i++) {
            FlowNode n = schema.nodes().get(i);
            String p = "/nodes/" + i;
            if (n == null) {
                errs.add(p + ": 必须为对象");
                continue;
            }
            if (isBlank(n.id())) {
                errs.add(p + "/id: 必填");
                continue;
            }
            if (!nodeIds.add(n.id())) {
                errs.add(p + "/id: 重复 (" + n.id() + ")");
            }
            if (n.type() == null || !FlowDtos.FLOW_NODE_TYPES.contains(n.type())) {
                errs.add(p + "/type: 未知节点类型 " + n.type());
            } else {
                nodeType.put(n.id(), n.type());
            }
            errs.addAll(approverErrors(n.approver(), p));
        }

        Set<String> edgeIds = new HashSet<>();
        List<FlowEdge> edges = schema.edges() == null ? List.of() : schema.edges();
        for (int i = 0; i < edges.size(); i++) {
            FlowEdge e = edges.get(i);
            String p = "/edges/" + i;
            if (e == null) {
                errs.add(p + ": 必须为对象");
                continue;
            }
            if (isBlank(e.id())) {
                errs.add(p + "/id: 必填");
                continue;
            }
            if (!edgeIds.add(e.id())) {
                errs.add(p + "/id: 重复");
            }
            if (!nodeIds.contains(String.valueOf(e.from()))) {
                errs.add(p + "/from: 端点不存在 (" + e.from() + ")");
            }
            if (!nodeIds.contains(String.valueOf(e.to()))) {
                errs.add(p + "/to: 端点不存在 (" + e.to() + ")");
            }
            if (e.from() != null && e.from().equals(e.to())) {
                errs.add(p + ": 自环边禁止");
            }
        }

        List<String> starts = new ArrayList<>();
        int ends = 0;
        for (FlowNode n : schema.nodes()) {
            if (n == null || n.type() == null) {
                continue;
            }
            if ("START".equals(n.type())) {
                starts.add(n.id());
            } else if ("END".equals(n.type())) {
                ends++;
            }
        }
        if (starts.size() != 1) {
            errs.add("/nodes: START 节点必须恰好 1 个");
        }
        if (ends == 0) {
            errs.add("/nodes: END 节点至少 1 个");
        }

        boolean endpointsBroken = errs.stream().anyMatch(x -> x.contains("端点不存在"));
        if (starts.size() == 1 && !endpointsBroken) {
            String startId = starts.get(0);
            Map<String, List<String>> adj = new HashMap<>();
            for (FlowEdge e : edges) {
                if (e == null || e.from() == null || e.to() == null) {
                    continue;
                }
                adj.computeIfAbsent(e.from(), k -> new ArrayList<>()).add(e.to());
            }
            // 连通性：START 出发 BFS
            Set<String> seen = new HashSet<>();
            seen.add(startId);
            Deque<String> queue = new ArrayDeque<>();
            queue.add(startId);
            while (!queue.isEmpty()) {
                String cur = queue.poll();
                for (String nxt : adj.getOrDefault(cur, List.of())) {
                    if (seen.add(nxt)) {
                        queue.add(nxt);
                    }
                }
            }
            for (String id : nodeIds) {
                if (!seen.contains(id)) {
                    errs.add("/nodes: 节点不可达 (" + id + "——START 出发不可及)");
                }
            }
            // 无环：三色 DFS
            Map<String, Integer> color = new HashMap<>();
            for (String id : nodeIds) {
                color.put(id, 0);
            }
            boolean cyclic = hasCycle(startId, adj, color);
            if (cyclic) {
                errs.add("/edges: 存在环路（阶段 B 不支持回退边）");
            }
        }
        return errs;
    }

    private static boolean hasCycle(String start, Map<String, List<String>> adj, Map<String, Integer> color) {
        // 迭代实现，避免深流程栈溢出
        Deque<String> stack = new ArrayDeque<>();
        Deque<Integer> cursor = new ArrayDeque<>();
        color.put(start, 1);
        stack.push(start);
        cursor.push(0);
        while (!stack.isEmpty()) {
            String u = stack.peek();
            int idx = cursor.pop();
            List<String> next = adj.getOrDefault(u, List.of());
            if (idx < next.size()) {
                cursor.push(idx + 1);
                String v = next.get(idx);
                int c = color.getOrDefault(v, 0);
                if (c == 1) {
                    return true;
                }
                if (c == 0) {
                    color.put(v, 1);
                    stack.push(v);
                    cursor.push(0);
                }
            } else {
                color.put(u, 2);
                stack.pop();
            }
        }
        return false;
    }

    private static List<String> approverErrors(ApproverRule rule, String nodePtr) {
        List<String> errs = new ArrayList<>();
        if (rule == null) {
            return errs;
        }
        if (rule instanceof UserApprover u) {
            if (u.userIds() == null || u.userIds().isEmpty()) {
                errs.add(nodePtr + "/approver/userIds: USER 模式必填非空");
            }
        } else if (rule instanceof DeptRoleApprover d) {
            if (d.roleKeys() == null || d.roleKeys().isEmpty()) {
                errs.add(nodePtr + "/approver/roleKeys: DEPT_ROLE 模式必填非空");
            }
        } else if (rule instanceof InitiatorSupervisorApprover) {
            // fallbackUserIds 允许为空（缺失时走 BLOCK）
        } else {
            errs.add(nodePtr + "/approver/mode: 未知模式");
        }
        return errs;
    }

    private static BizException schemaInvalid(List<String> errors) {
        return new BizException(FlowErrors.SCHEMA_INVALID, "流程结构校验不通过",
                Map.of("errors", errors));
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }
}