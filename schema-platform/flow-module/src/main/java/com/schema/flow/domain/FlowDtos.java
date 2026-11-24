package com.schema.flow.domain;

import java.util.List;

/**
 * FlowSchema 域的 Java 镜像（spec 021 T1）。
 *
 * ⚠️ 真源约束：结构以 schema-protocol（020 冻结版）为准——
 * 大写七型 {@code FLOW_NODE_TYPES} 与三模式 {@code APPROVER_RULE_MODES}；
 * **不得**按 10FE §2.1 旧草案（小写八型 + 六规则）另立一套。
 * 本文件只做「结构镜像 + 常量枚举」，不做执行能力声明（执行白名单见 {@link SupportedNodeTypes}）。
 */
public final class FlowDtos {

    private FlowDtos() {
    }

    /** 协议七型（与 types.ts FLOW_NODE_TYPES 逐字一致）。 */
    public static final List<String> FLOW_NODE_TYPES = List.of(
            "START", "END", "APPROVAL", "CC",
            "CONDITION_BRANCH", "PARALLEL_GATEWAY", "MERGE_GATEWAY");

    /** 审批人三模式（与 types.ts APPROVER_RULE_MODES 逐字一致）。 */
    public static final List<String> APPROVER_RULE_MODES = List.of(
            "USER", "DEPT_ROLE", "INITIATOR_SUPERVISOR");

    /** 审批人规则（封闭联合：三模式，未知模式校验拒）。 */
    public sealed interface ApproverRule permits UserApprover, DeptRoleApprover, InitiatorSupervisorApprover {
    }

    /** USER 模式：userIds 逐个解析。 */
    public record UserApprover(List<String> userIds) implements ApproverRule {
    }

    /** DEPT_ROLE 模式：发起人所在部门 × roleKeys 匹配成员。 */
    public record DeptRoleApprover(List<String> roleKeys) implements ApproverRule {
    }

    /** INITIATOR_SUPERVISOR 模式：发起人直属上级，缺失时用 fallbackUserIds。 */
    public record InitiatorSupervisorApprover(List<String> fallbackUserIds) implements ApproverRule {
    }

    /** 条件分支出口（阶段 B 不支持执行，仅结构镜像与发布校验消费）。 */
    public record FlowBranch(String id, String label, Integer priority) {
    }

    /** 流程节点。 */
    public record FlowNode(String id, String type, String name, ApproverRule approver, List<FlowBranch> branches) {
    }

    /** 流程边。 */
    public record FlowEdge(String id, String from, String to, String branchId) {
    }

    /** 流程定义结构（发布/保存的校验输入）。 */
    public record FlowSchema(String flowKey, String name, Integer version, Integer schemaVersion,
            List<FlowNode> nodes, List<FlowEdge> edges) {
    }
}