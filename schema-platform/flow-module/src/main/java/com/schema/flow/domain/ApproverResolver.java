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
 *   INITIATOR_SUPERVISOR    → 发起人直属上级；缺失时用 fallbackUserIds
 * </pre>
 *
 * ⚠️ 能力边界（实现时核实，必须如实记录）：
 * 本系统 sys_dept 只有 (parent_id, path)，**没有「部门负责人」字段**。
 * 因此 INITIATOR_SUPERVISOR 的语义落在「发起人所在部门的上一级部门成员」，
 * 且仅当显式配置了 fallbackUserIds 才能兜底；若上级部门也无成员 →
 * 返回空集，由调用方按 BLOCK 策略挂起实例。
 *
 * 不臆造「leader 字段」——宁可解析为空触发 BLOCK（可见、可告警），
 * 也不要用一个不存在的概念假装解析成功（会导致流程静默走进死路）。
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
                Long parentDeptId = org.findParentDeptId(tenantId, deptId);
                if (parentDeptId != null) {
                    List<Long> supervisors = dedup(org.findUsersInDept(tenantId, parentDeptId));
                    if (!supervisors.isEmpty()) {
                        return supervisors;
                    }
                }
            }
            // 上级部门解析不到 → 用配置的兜底人（可为空 → BLOCK）
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