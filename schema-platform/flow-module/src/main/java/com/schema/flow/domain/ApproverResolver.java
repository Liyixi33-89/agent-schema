package com.schema.flow.domain;

import com.schema.flow.domain.FlowDtos.ApproverRule;
import com.schema.flow.domain.FlowDtos.DeptRoleApprover;
import com.schema.flow.domain.FlowDtos.InitiatorSupervisorApprover;
import com.schema.flow.domain.FlowDtos.UserApprover;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 审批人解析（spec 021 T6 / 05BE §3 三模式）。
 *
 * <pre>
 *   USER                    → userIds 逐个解析
 *   DEPT_ROLE               → 发起人所在部门 × roleKeys 匹配成员
 *   INITIATOR_SUPERVISOR    → 本部门负责人 → 上级部门负责人 → fallbackUserIds
 * </pre>
 *
 * ⚠️ INITIATOR_SUPERVISOR 的语义演进（2026-11-24 确认后修正）：
 * V3 建 sys_dept 时只有 (parent_id, path)，无负责人概念，最初实现只能退化为
 * 「上一级部门全体成员」——多人时全部成为候选人，与「直属上级单人审批」不符。
 * V19 补了 sys_dept.leader_id 后改为**单人优先级链**：
 *   ① 本部门 leader → ② 上级部门 leader → ③ 流程配置的 fallbackUserIds → ④ 空(BLOCK)
 *
 * 刻意**不**回落到「上级部门全体成员」：那会让「负责人未配置」这个组织数据问题
 * 被静默掩盖成「多人会签」。宁可 BLOCK 挂起（可见、可告警、可修复）。
 */
public final class ApproverResolver {

    private ApproverResolver() {
    }

    /** 机构数据查询端口（DIP：领域不依赖 iam 模块实现）。 */
    public interface OrgQueryPort {

        /** 用户在指定部门（deptId）内、拥有任一 roleKey 的成员 id。 */
        List<Long> findUsersInDeptWithRoles(long tenantId, long deptId, List<String> roleKeys);

        /** 用户主部门 id；无则 null。 */
        Long findPrimaryDeptId(long tenantId, long userId);

        /** 部门的上一级部门 id；顶层返回 null。 */
        Long findParentDeptId(long tenantId, long deptId);

        /** 部门全体成员 id。 */
        List<Long> findUsersInDept(long tenantId, long deptId);

        /**
         * 部门负责人 id（sys_dept.leader_id，V19）；未设置返回 null。
         * 「直属上级审批」的首选解析目标——单人，而非整个上级部门。
         */
        Long findDeptLeaderId(long tenantId, long deptId);
    }

    /**
     * 解析该节点应指派给谁。
     *
     * @return 去重后的用户 id 列表；**空列表表示解析失败**（调用方按 BLOCK 挂起）
     */
    public static List<Long> resolve(ApproverRule rule, long tenantId, long initiatorId,
            OrgQueryPort org) {
        if (rule == null) {
            return List.of();
        }
        if (rule instanceof UserApprover u) {
            return parseUserIds(u.userIds());
        }
        if (rule instanceof DeptRoleApprover d) {
            Long deptId = org.findPrimaryDeptId(tenantId, initiatorId);
            if (deptId == null) {
                // 发起人无部门 → 无法按部门×角色解析，交给 BLOCK
                return List.of();
            }
            return dedup(org.findUsersInDeptWithRoles(tenantId, deptId, d.roleKeys()));
        }
        if (rule instanceof InitiatorSupervisorApprover s) {
            Long deptId = org.findPrimaryDeptId(tenantId, initiatorId);
            if (deptId != null) {
                // ① 本部门负责人（sys_dept.leader_id，V19）——语义最贴近「直属上级」
                Long leader = org.findDeptLeaderId(tenantId, deptId);
                if (leader != null && leader != initiatorId) {
                    return List.of(leader);
                }
                // ② 上级部门负责人（发起人自己就是本部门负责人时的自然上一级）
                Long parentDeptId = org.findParentDeptId(tenantId, deptId);
                if (parentDeptId != null) {
                    Long parentLeader = org.findDeptLeaderId(tenantId, parentDeptId);
                    if (parentLeader != null && parentLeader != initiatorId) {
                        return List.of(parentLeader);
                    }
                }
            }
            // ③ 配置的兜底人（可为空 → BLOCK）
            //    ⚠️ 不回落到「上级部门全体成员」：那样多人时全成候选人，
            //       与「直属上级单人审批」预期不符，且会掩盖「负责人未配置」这一组织数据问题。
            return parseUserIds(s.fallbackUserIds());
        }
        return List.of();
    }

    /** userIds 是协议里的字符串数组，需过滤非数字与空值。 */
    private static List<Long> parseUserIds(List<String> raw) {
        if (raw == null || raw.isEmpty()) {
            return List.of();
        }
        Set<Long> out = new LinkedHashSet<>();
        for (String s : raw) {
            if (s == null || s.isBlank()) {
                continue;
            }
            try {
                out.add(Long.parseLong(s.trim()));
            } catch (NumberFormatException ignored) {
                // 非数字 id 跳过：宁可少解析一个人，也不因脏数据让整条流程瘫痪
            }
        }
        return new ArrayList<>(out);
    }

    private static List<Long> dedup(List<Long> in) {
        if (in == null || in.isEmpty()) {
            return List.of();
        }
        return new ArrayList<>(new LinkedHashSet<>(in));
    }
}