package com.schema.flow.domain;

import com.schema.flow.domain.FlowDtos.ApproverRule;
import com.schema.flow.domain.FlowDtos.DeptRoleApprover;
import com.schema.flow.domain.FlowDtos.FlowBranch;
import com.schema.flow.domain.FlowDtos.FlowEdge;
import com.schema.flow.domain.FlowDtos.FlowNode;
import com.schema.flow.domain.FlowDtos.FlowSchema;
import com.schema.flow.domain.FlowDtos.InitiatorSupervisorApprover;
import com.schema.flow.domain.FlowDtos.UserApprover;
import com.schema.platform.common.json.Json;
import com.schema.platform.common.web.BizException;
import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * FlowSchema ↔ JSON 映射（spec 021 T1）。
 *
 * 为什么不用 Gson 直接反序列化：{@link ApproverRule} 是 sealed 封闭联合，
 * Gson 无法按 mode 字段分派到具体 record（会试图实例化抽象类型）。
 * 这里按 mode 显式分派——同时把「未知模式」变成明确错误，
 * 而不是静默丢字段（静默丢 approver 会导致审批人解析为空、实例挂起，
 * 属于最难排查的一类故障）。
 */
public final class FlowSchemaMapper {

    private FlowSchemaMapper() {
    }

    /**
     * JSON 文本 → FlowSchema。
     *
     * @throws BizException FLOW_SCHEMA_INVALID（结构不可解析）
     */
    @SuppressWarnings("unchecked")
    public static FlowSchema fromJson(String json) {
        if (json == null || json.isBlank()) {
            throw invalid("/: 流程结构为空");
        }
        Map<String, Object> root;
        try {
            root = Json.readMap(json);
        } catch (RuntimeException e) {
            throw invalid("/: 不是合法 JSON");
        }
        return fromMap(root);
    }

    @SuppressWarnings("unchecked")
    public static FlowSchema fromMap(Map<String, Object> root) {
        if (root == null) {
            throw invalid("/: 流程结构为空");
        }
        String flowKey = str(root.get("flowKey"));
        String name = str(root.get("name"));
        Integer version = intOrNull(root.get("version"));
        Integer schemaVersion = intOrNull(root.get("schemaVersion"));

        List<FlowNode> nodes = new ArrayList<>();
        Object rawNodes = root.get("nodes");
        if (rawNodes instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> m) {
                    nodes.add(nodeFromMap((Map<String, Object>) m));
                } else {
                    nodes.add(null);
                }
            }
        }

        List<FlowEdge> edges = new ArrayList<>();
        Object rawEdges = root.get("edges");
        if (rawEdges instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> m) {
                    edges.add(edgeFromMap((Map<String, Object>) m));
                } else {
                    edges.add(null);
                }
            }
        }

        return new FlowSchema(flowKey, name, version, schemaVersion, nodes, edges);
    }

    @SuppressWarnings("unchecked")
    private static FlowNode nodeFromMap(Map<String, Object> m) {
        String id = str(m.get("id"));
        String type = str(m.get("type"));
        String name = str(m.get("name"));
        ApproverRule approver = approverFromMap(m.get("approver"));

        List<FlowBranch> branches = new ArrayList<>();
        Object rawBranches = m.get("branches");
        if (rawBranches instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> bm) {
                    Map<String, Object> b = (Map<String, Object>) bm;
                    branches.add(new FlowBranch(str(b.get("id")), str(b.get("label")),
                            intOrNull(b.get("priority"))));
                }
            }
        }
        return new FlowNode(id, type, name, approver, branches);
    }

    @SuppressWarnings("unchecked")
    private static ApproverRule approverFromMap(Object raw) {
        if (raw == null) {
            return null;
        }
        if (!(raw instanceof Map<?, ?> m)) {
            throw invalid("/approver: 必须为对象");
        }
        Map<String, Object> a = (Map<String, Object>) m;
        String mode = str(a.get("mode"));
        if (mode == null) {
            throw invalid("/approver/mode: 必填");
        }
        return switch (mode) {
            case "USER" -> new UserApprover(strList(a.get("userIds")));
            case "DEPT_ROLE" -> new DeptRoleApprover(strList(a.get("roleKeys")));
            case "INITIATOR_SUPERVISOR" -> new InitiatorSupervisorApprover(strList(a.get("fallbackUserIds")));
            // 未知模式必须显式拒绝：静默丢弃会让审批人解析为空 → 实例挂起，极难排查
            default -> throw invalid("/approver/mode: 未知模式 " + mode);
        };
    }

    private static FlowEdge edgeFromMap(Map<String, Object> m) {
        return new FlowEdge(str(m.get("id")), str(m.get("from")), str(m.get("to")),
                str(m.get("branchId")));
    }

    /**
     * FlowSchema → JSON 文本（写库用）。
     *
     * ⚠️ 不能直接 {@code Json.write(schema)}：Gson 序列化 {@link ApproverRule} 时
     * 只输出具体 record 的字段（userIds/roleKeys/fallbackUserIds），
     * **mode 判别符会丢失**，反序列化时必然撞「mode 必填」。
     * 这里逐层手工构造，显式写入 mode——这是 sealed 联合落 JSON 的必需动作。
     */
    public static String toJson(FlowSchema schema) {
        JsonObject root = new JsonObject();
        root.addProperty("flowKey", schema.flowKey());
        root.addProperty("name", schema.name());
        if (schema.version() != null) {
            root.addProperty("version", schema.version());
        }
        if (schema.schemaVersion() != null) {
            root.addProperty("schemaVersion", schema.schemaVersion());
        }

        JsonArray nodes = new JsonArray();
        if (schema.nodes() != null) {
            for (FlowNode n : schema.nodes()) {
                if (n == null) {
                    nodes.add(JsonNull.INSTANCE);
                    continue;
                }
                JsonObject o = new JsonObject();
                o.addProperty("id", n.id());
                o.addProperty("type", n.type());
                if (n.name() != null) {
                    o.addProperty("name", n.name());
                }
                if (n.approver() != null) {
                    o.add("approver", approverToJson(n.approver()));
                }
                if (n.branches() != null && !n.branches().isEmpty()) {
                    JsonArray arr = new JsonArray();
                    for (FlowBranch b : n.branches()) {
                        JsonObject bo = new JsonObject();
                        bo.addProperty("id", b.id());
                        if (b.label() != null) {
                            bo.addProperty("label", b.label());
                        }
                        if (b.priority() != null) {
                            bo.addProperty("priority", b.priority());
                        }
                        arr.add(bo);
                    }
                    o.add("branches", arr);
                }
                nodes.add(o);
            }
        }
        root.add("nodes", nodes);

        JsonArray edges = new JsonArray();
        if (schema.edges() != null) {
            for (FlowEdge e : schema.edges()) {
                if (e == null) {
                    edges.add(JsonNull.INSTANCE);
                    continue;
                }
                JsonObject o = new JsonObject();
                o.addProperty("id", e.id());
                o.addProperty("from", e.from());
                o.addProperty("to", e.to());
                if (e.branchId() != null) {
                    o.addProperty("branchId", e.branchId());
                }
                edges.add(o);
            }
        }
        root.add("edges", edges);

        return root.toString();
    }

    /** sealed 联合 → JSON：必须写入 mode 判别符。 */
    private static JsonObject approverToJson(ApproverRule rule) {
        JsonObject o = new JsonObject();
        if (rule instanceof UserApprover u) {
            o.addProperty("mode", "USER");
            o.add("userIds", strArray(u.userIds()));
        } else if (rule instanceof DeptRoleApprover d) {
            o.addProperty("mode", "DEPT_ROLE");
            o.add("roleKeys", strArray(d.roleKeys()));
        } else if (rule instanceof InitiatorSupervisorApprover s) {
            o.addProperty("mode", "INITIATOR_SUPERVISOR");
            if (s.fallbackUserIds() != null) {
                o.add("fallbackUserIds", strArray(s.fallbackUserIds()));
            }
        }
        return o;
    }

    private static JsonArray strArray(List<String> values) {
        JsonArray arr = new JsonArray();
        if (values != null) {
            for (String v : values) {
                arr.add(v);
            }
        }
        return arr;
    }

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }

    private static Integer intOrNull(Object o) {
        if (o instanceof Number n) {
            return n.intValue();
        }
        if (o instanceof String s && !s.isBlank()) {
            try {
                return Integer.parseInt(s.trim());
            } catch (NumberFormatException e) {
                return null;
            }
        }
        return null;
    }

    private static List<String> strList(Object o) {
        if (!(o instanceof List<?> list)) {
            return List.of();
        }
        List<String> out = new ArrayList<>(list.size());
        for (Object item : list) {
            if (item != null && !String.valueOf(item).isBlank()) {
                out.add(String.valueOf(item));
            }
        }
        return out;
    }

    private static BizException invalid(String pointer) {
        return new BizException(FlowErrors.SCHEMA_INVALID, "流程结构不可解析: " + pointer,
                Map.of("errors", List.of(pointer)));
    }
}