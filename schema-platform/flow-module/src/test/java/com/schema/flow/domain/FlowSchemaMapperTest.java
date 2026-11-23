package com.schema.flow.domain;

import com.schema.flow.domain.FlowDtos.DeptRoleApprover;
import com.schema.flow.domain.FlowDtos.FlowEdge;
import com.schema.flow.domain.FlowDtos.FlowNode;
import com.schema.flow.domain.FlowDtos.FlowSchema;
import com.schema.flow.domain.FlowDtos.InitiatorSupervisorApprover;
import com.schema.flow.domain.FlowDtos.UserApprover;
import com.schema.platform.common.web.BizException;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * FlowSchema JSON 映射单测（spec 021 T1「与 schema-protocol 同构镜像」）。
 *
 * 重点保护：三模式能正确往返；未知模式显式拒绝（静默丢弃会导致审批人为空→实例挂起）。
 */
class FlowSchemaMapperTest {

    private static final String LINEAR_JSON = """
            {
              "flowKey": "leave",
              "name": "请假流程",
              "version": 1,
              "schemaVersion": 1,
              "nodes": [
                {"id": "s1", "type": "START", "name": "开始"},
                {"id": "a1", "type": "APPROVAL", "name": "主管审批",
                 "approver": {"mode": "USER", "userIds": ["7", "9"]}},
                {"id": "e1", "type": "END", "name": "结束"}
              ],
              "edges": [
                {"id": "f1", "from": "s1", "to": "a1"},
                {"id": "f2", "from": "a1", "to": "e1"}
              ]
            }
            """;

    @Test
    void parsesLinearFlow() {
        FlowSchema s = FlowSchemaMapper.fromJson(LINEAR_JSON);

        assertEquals("leave", s.flowKey());
        assertEquals("请假流程", s.name());
        assertEquals(1, s.schemaVersion());
        assertEquals(3, s.nodes().size());
        assertEquals(2, s.edges().size());

        FlowNode approval = s.nodes().get(1);
        assertEquals("APPROVAL", approval.type());
        UserApprover rule = assertInstanceOf(UserApprover.class, approval.approver());
        assertEquals(List.of("7", "9"), rule.userIds());
    }

    @Test
    void roundTripsThroughJson() {
        FlowSchema parsed = FlowSchemaMapper.fromJson(LINEAR_JSON);
        String json = FlowSchemaMapper.toJson(parsed);
        FlowSchema again = FlowSchemaMapper.fromJson(json);

        assertEquals(parsed.flowKey(), again.flowKey());
        assertEquals(parsed.nodes().size(), again.nodes().size());
        // 关键：sealed 联合必须还能还原成具体类型
        assertInstanceOf(UserApprover.class, again.nodes().get(1).approver());
        // 往返后仍通过结构校验
        FlowSchemaValidator.validateForPublish(again);
    }

    @Test
    void parsesAllThreeApproverModes() {
        String json = """
                {
                  "flowKey": "k", "name": "n", "schemaVersion": 1,
                  "nodes": [
                    {"id": "s1", "type": "START"},
                    {"id": "u", "type": "APPROVAL", "approver": {"mode": "USER", "userIds": ["1"]}},
                    {"id": "d", "type": "APPROVAL", "approver": {"mode": "DEPT_ROLE", "roleKeys": ["mgr"]}},
                    {"id": "v", "type": "APPROVAL", "approver": {"mode": "INITIATOR_SUPERVISOR",
                     "fallbackUserIds": ["99"]}},
                    {"id": "e1", "type": "END"}
                  ],
                  "edges": [
                    {"id": "f1", "from": "s1", "to": "u"},
                    {"id": "f2", "from": "u", "to": "d"},
                    {"id": "f3", "from": "d", "to": "v"},
                    {"id": "f4", "from": "v", "to": "e1"}
                  ]
                }
                """;
        FlowSchema s = FlowSchemaMapper.fromJson(json);

        assertInstanceOf(UserApprover.class, s.nodes().get(1).approver());
        assertInstanceOf(DeptRoleApprover.class, s.nodes().get(2).approver());
        InitiatorSupervisorApprover sup =
                assertInstanceOf(InitiatorSupervisorApprover.class, s.nodes().get(3).approver());
        assertEquals(List.of("99"), sup.fallbackUserIds());
    }

    @Test
    void rejectsUnknownApproverModeExplicitly() {
        String json = """
                {
                  "flowKey": "k", "name": "n", "schemaVersion": 1,
                  "nodes": [
                    {"id": "s1", "type": "START"},
                    {"id": "a1", "type": "APPROVAL", "approver": {"mode": "ROLE_ONLY_FROM_OLD_DRAFT"}},
                    {"id": "e1", "type": "END"}
                  ],
                  "edges": [{"id": "f1", "from": "s1", "to": "a1"},
                            {"id": "f2", "from": "a1", "to": "e1"}]
                }
                """;
        BizException e = assertThrows(BizException.class, () -> FlowSchemaMapper.fromJson(json));
        assertEquals(FlowErrors.SCHEMA_INVALID, e.code());
        assertTrue(e.getMessage().contains("未知模式"));
    }

    @Test
    void rejectsMalformedJson() {
        assertThrows(BizException.class, () -> FlowSchemaMapper.fromJson("{not json"));
        assertThrows(BizException.class, () -> FlowSchemaMapper.fromJson(""));
    }

    @Test
    void parsesConditionBranchWithBranches() {
        // 草稿允许存 CONDITION_BRANCH（结构镜像必须完整），发布时才拒
        String json = """
                {
                  "flowKey": "k", "name": "n", "schemaVersion": 1,
                  "nodes": [
                    {"id": "s1", "type": "START"},
                    {"id": "c1", "type": "CONDITION_BRANCH", "name": "金额判断",
                     "branches": [{"id": "big", "label": "大于一万", "priority": 1}]},
                    {"id": "e1", "type": "END"}
                  ],
                  "edges": [
                    {"id": "f1", "from": "s1", "to": "c1"},
                    {"id": "f2", "from": "c1", "to": "e1", "branchId": "big"}
                  ]
                }
                """;
        FlowSchema s = FlowSchemaMapper.fromJson(json);

        FlowNode branch = s.nodes().get(1);
        assertEquals("CONDITION_BRANCH", branch.type());
        assertNotNull(branch.branches());
        assertEquals("big", branch.branches().get(0).id());
        assertEquals("大于一万", branch.branches().get(0).label());
        assertEquals("big", s.edges().get(1).branchId());

        FlowSchemaValidator.validateForSave(s);
        assertThrows(BizException.class, () -> FlowSchemaValidator.validateForPublish(s));
    }
}