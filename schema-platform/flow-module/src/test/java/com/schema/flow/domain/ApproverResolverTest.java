package com.schema.flow.domain;

import com.schema.flow.domain.ApproverResolver.OrgQueryPort;
import com.schema.flow.domain.FlowDtos.DeptRoleApprover;
import com.schema.flow.domain.FlowDtos.InitiatorSupervisorApprover;
import com.schema.flow.domain.FlowDtos.UserApprover;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 审批人解析单测（spec 021 T6）。
 *
 * 重点保护「解析为空」的判定——它触发 BLOCK 挂起，
 * 是最容易被写成「静默继续」而留下死流程的地方。
 */
class ApproverResolverTest {

    private static final long TENANT = 51L;
    private static final long INITIATOR = 100L;

    // ---------- USER 模式 ----------

    @Test
    void resolvesExplicitUserIds() {
        List<Long> out = ApproverResolver.resolve(
                new UserApprover(List.of("7", "9")), TENANT, INITIATOR, new FakeOrg());

        assertEquals(List.of(7L, 9L), out);
    }

    @Test
    void deduplicatesUserIds() {
        List<Long> out = ApproverResolver.resolve(
                new UserApprover(List.of("7", "7", "9")), TENANT, INITIATOR, new FakeOrg());

        assertEquals(List.of(7L, 9L), out, "重复 id 必须去重（否则会生成重复候选人）");
    }

    @Test
    void skipsMalformedUserIdsButKeepsValid() {
        List<Long> out = ApproverResolver.resolve(
                new UserApprover(List.of("7", "abc", "", "9")), TENANT, INITIATOR, new FakeOrg());

        assertEquals(List.of(7L, 9L), out, "脏数据跳过，不能让整条流程瘫痪");
    }

    @Test
    void emptyUserListResolvesToEmpty() {
        List<Long> out = ApproverResolver.resolve(
                new UserApprover(List.of()), TENANT, INITIATOR, new FakeOrg());

        assertTrue(out.isEmpty(), "空列表 → BLOCK");
    }

    // ---------- DEPT_ROLE 模式 ----------

    @Test
    void resolvesDeptRoleMembers() {
        FakeOrg org = new FakeOrg();
        org.primaryDept.put(INITIATOR, 12L);
        org.deptRoleMembers.put("12|dept_manager", List.of(200L, 201L));

        List<Long> out = ApproverResolver.resolve(
                new DeptRoleApprover(List.of("dept_manager")), TENANT, INITIATOR, org);

        assertEquals(List.of(200L, 201L), out);
    }

    @Test
    void deptRoleWithNoMatchingMemberBlocks() {
        FakeOrg org = new FakeOrg();
        org.primaryDept.put(INITIATOR, 12L);
        // 部门有，但没人有该角色

        List<Long> out = ApproverResolver.resolve(
                new DeptRoleApprover(List.of("dept_manager")), TENANT, INITIATOR, org);

        assertTrue(out.isEmpty(), "无匹配成员 → BLOCK（A9 场景）");
    }

    @Test
    void deptRoleWhenInitiatorHasNoDeptBlocks() {
        FakeOrg org = new FakeOrg(); // 未设 primaryDept

        List<Long> out = ApproverResolver.resolve(
                new DeptRoleApprover(List.of("dept_manager")), TENANT, INITIATOR, org);

        assertTrue(out.isEmpty(), "发起人无部门 → BLOCK，不能猜测");
    }

    // ---------- INITIATOR_SUPERVISOR 模式 ----------

    @Test
    void resolvesSupervisorFromParentDept() {
        FakeOrg org = new FakeOrg();
        org.primaryDept.put(INITIATOR, 12L);
        org.parentDept.put(12L, 5L);
        org.deptMembers.put(5L, List.of(300L));

        List<Long> out = ApproverResolver.resolve(
                new InitiatorSupervisorApprover(List.of()), TENANT, INITIATOR, org);

        assertEquals(List.of(300L), out);
    }

    @Test
    void fallsBackWhenParentDeptHasNoMember() {
        FakeOrg org = new FakeOrg();
        org.primaryDept.put(INITIATOR, 12L);
        org.parentDept.put(12L, 5L);
        // 上级部门没人

        List<Long> out = ApproverResolver.resolve(
                new InitiatorSupervisorApprover(List.of("99")), TENANT, INITIATOR, org);

        assertEquals(List.of(99L), out, "上级解析不到时用 fallbackUserIds");
    }

    @Test
    void blocksWhenNoSupervisorAndNoFallback() {
        FakeOrg org = new FakeOrg();
        org.primaryDept.put(INITIATOR, 12L);
        // 顶层部门（无 parent）+ 无 fallback

        List<Long> out = ApproverResolver.resolve(
                new InitiatorSupervisorApprover(List.of()), TENANT, INITIATOR, org);

        assertTrue(out.isEmpty(), "无上级且无兜底 → BLOCK");
    }

    @Test
    void nullRuleResolvesToEmpty() {
        assertTrue(ApproverResolver.resolve(null, TENANT, INITIATOR, new FakeOrg()).isEmpty());
    }

    // ---------- 测试替身 ----------

    private static class FakeOrg implements OrgQueryPort {
        final Map<Long, Long> primaryDept = new HashMap<>();
        final Map<Long, Long> parentDept = new HashMap<>();
        final Map<String, List<Long>> deptRoleMembers = new HashMap<>();
        final Map<Long, List<Long>> deptMembers = new HashMap<>();

        @Override
        public List<Long> findUsersInDeptWithRoles(long tenantId, long deptId, List<String> roleKeys) {
            List<Long> out = new ArrayList<>();
            for (String k : roleKeys) {
                out.addAll(deptRoleMembers.getOrDefault(deptId + "|" + k, List.of()));
            }
            return out;
        }

        @Override
        public Long findPrimaryDeptId(long tenantId, long userId) {
            return primaryDept.get(userId);
        }

        @Override
        public Long findParentDeptId(long tenantId, long deptId) {
            return parentDept.get(deptId);
        }

        @Override
        public List<Long> findUsersInDept(long tenantId, long deptId) {
            return deptMembers.getOrDefault(deptId, List.of());
        }
    }
}