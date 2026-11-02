package com.schema.iam.application;

import com.schema.iam.domain.model.UserAccount;
import com.schema.iam.domain.repository.IamRepository;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.web.BizException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 应用角色与成员服务（13BE §3.1/§3.2）。
 *
 * <p>职责：应用创建时初始化三个默认应用角色（app_admin/developer/user）；
 * 成员添加/变更/移除（复用 grantRoles 席位守卫与审计口径）；最后一名应用管理员保护（防孤儿应用）。
 * 应用生命周期本体（CRUD/归档/删除）在 app-module 的 AppService——本类只管「角色与成员」这一 IAM 侧切口。
 */
@Service
public class AppRoleService {

    /** 应用默认三角色（13BE §3.1：创建者自动获得 app_admin）。 */
    public static final String CODE_APP_ADMIN = "app_admin";
    public static final String CODE_DEVELOPER = "developer";
    public static final String CODE_USER = "user";

    private final IamRepository iam;
    private final ObjectProvider<SeatGrantGuard> seatGuard;

    public AppRoleService(IamRepository iam,
            @Autowired(required = false) ObjectProvider<SeatGrantGuard> seatGuard) {
        this.iam = iam;
        this.seatGuard = seatGuard;
    }

    /** 应用角色初始化（13BE §3.1）：幂等——重放/并发创建不重复建角色。 */
    @Transactional
    public void initDefaultRoles(long tenantId, long appId) {
        iam.ensureAppRole(tenantId, appId, CODE_APP_ADMIN, "应用管理员");
        iam.ensureAppRole(tenantId, appId, CODE_DEVELOPER, "开发者");
        iam.ensureAppRole(tenantId, appId, CODE_USER, "使用者");
    }

    /** 创建者自动成为应用管理员（13BE §3.1）；不走 org:manage 闸门——创建应用即授权，单独审计。 */
    @Transactional
    public void grantCreatorAdmin(long tenantId, long appId, long creatorId, String ip, String ua) {
        Long roleId = iam.findRoleId(tenantId, appId, CODE_APP_ADMIN).orElse(null);
        if (roleId == null) {
            throw new BizException("ROLE_NOT_FOUND", "应用默认角色缺失: " + CODE_APP_ADMIN);
        }
        iam.replaceUserRoles(tenantId, creatorId, appId, List.of(roleId));
        iam.insertAudit("PERM_CHANGE", tenantId, creatorId, "APP", String.valueOf(appId),
                Map.of("action", "GRANT_CREATOR_ADMIN", "appId", appId), ip, ua);
    }

    /** 成员列表（13BE §A.2）：[{userId, name, roles[], joinedAt}]。 */
    public List<Map<String, Object>> listMembers(long tenantId, long appId) {
        Map<Long, Map<String, Object>> byUser = new LinkedHashMap<>();
        for (Map<String, Object> row : iam.findMembersOfApp(tenantId, appId)) {
            long userId = ((Number) row.get("user_id")).longValue();
            Map<String, Object> m = byUser.computeIfAbsent(userId, k -> {
                Map<String, Object> n = new LinkedHashMap<>();
                n.put("userId", k);
                n.put("name", row.get("name"));
                n.put("account", row.get("account"));
                n.put("roles", new ArrayList<String>());
                return n;
            });
            ((List<String>) m.get("roles")).add((String) row.get("role_code"));
        }
        return new ArrayList<>(byUser.values());
    }

    /** 添加成员（13BE §A.2）：目标用户必须属本租户；席位守卫与审计口径复用 AuthService.grantRoles。 */
    @Transactional
    public void addMember(long tenantId, long appId, long userId, List<String> roleCodes,
            Long operatorId, String ip, String ua) {
        UserAccount target = iam.findUserById(userId)
                .orElseThrow(() -> new BizException("USER_NOT_FOUND", "用户不存在"));
        if (target.tenantId() != tenantId) {
            throw new BizException("USER_NOT_FOUND", "用户不存在");
        }
        List<Long> roleIds = resolveRoleIds(tenantId, appId, roleCodes);
        grantWithSeatGuard(tenantId, appId, userId, roleIds, operatorId);
        iam.insertAudit("PERM_CHANGE", tenantId, operatorId, "APP", String.valueOf(appId),
                Map.of("action", "ADD_MEMBER", "userId", userId, "roleCodes", roleCodes), ip, ua);
    }

    /** 变更成员角色（覆盖式，13BE §3.2）。 */
    @Transactional
    public void updateMemberRoles(long tenantId, long appId, long userId, List<String> roleCodes,
            Long operatorId, String ip, String ua) {
        List<Long> roleIds = resolveRoleIds(tenantId, appId, roleCodes);
        // 最后一名应用管理员保护：移除 app_admin 前必须有其他管理员
        assertNotLastAdmin(tenantId, appId, userId, roleCodes);
        grantWithSeatGuard(tenantId, appId, userId, roleIds, operatorId);
        iam.insertAudit("PERM_CHANGE", tenantId, operatorId, "APP", String.valueOf(appId),
                Map.of("action", "UPDATE_MEMBER_ROLES", "userId", userId, "roleCodes", roleCodes), ip, ua);
    }

    /** 移除成员（13BE §A.2）：撤销该应用全部角色；最后一名应用管理员 409 APP_ADMIN_REQUIRED。 */
    @Transactional
    public void removeMember(long tenantId, long appId, long userId, Long operatorId, String ip, String ua) {
        assertNotLastAdmin(tenantId, appId, userId, List.of());
        iam.replaceUserRoles(tenantId, userId, appId, List.of());
        // 席位释放即时重算（13BE §2.4：成员变更当天快照同步）
        notifySeatChanged(tenantId);
        iam.insertAudit("PERM_CHANGE", tenantId, operatorId, "APP", String.valueOf(appId),
                Map.of("action", "REMOVE_MEMBER", "userId", userId), ip, ua);
    }

    /** 当前用户在应用的角色 codes（工作台 myRole 口径）。 */
    public List<String> myRoleCodes(long tenantId, long appId, long userId) {
        return iam.findRoleCodesOfUserInApp(tenantId, userId, appId);
    }

    // ---------- 内部 ----------

    private List<Long> resolveRoleIds(long tenantId, long appId, List<String> roleCodes) {
        List<Long> roleIds = new ArrayList<>();
        for (String code : roleCodes) {
            Long roleId = iam.findRoleId(tenantId, appId, code).orElse(null);
            if (roleId == null) {
                throw new BizException("ROLE_NOT_FOUND", "角色不属于该应用: " + code);
            }
            roleIds.add(roleId);
        }
        return roleIds;
    }

    private void grantWithSeatGuard(long tenantId, long appId, long userId, List<Long> roleIds, Long operatorId) {
        // 席位硬限判定（授权口径实时生效——先于角色写入，失败事务回滚不落库）
        if (seatGuard != null) {
            SeatGrantGuard guard = seatGuard.getIfAvailable();
            if (guard != null) {
                List<Long> design = new ArrayList<>();
                for (Long roleId : roleIds) {
                    String code = iam.findRoleCode(roleId);
                    if (CODE_APP_ADMIN.equals(code) || CODE_DEVELOPER.equals(code)) {
                        design.add(userId);
                        break;
                    }
                }
                guard.assertGrantAllowed(tenantId, design);
            }
        }
        iam.replaceUserRoles(tenantId, userId, appId, roleIds);
        notifySeatChanged(tenantId);
    }

    /**
     * 最后一名应用管理员保护（13BE §3.2：防孤儿应用）。
     * 场景：目标用户当前持 app_admin，且本次操作会使其失去 app_admin（移除成员 / 角色变更为非管理员）。
     */
    private void assertNotLastAdmin(long tenantId, long appId, long userId, List<String> newRoleCodes) {
        List<String> current = iam.findRoleCodesOfUserInApp(tenantId, userId, appId);
        if (!current.contains(CODE_APP_ADMIN)) {
            return; // 目标不是管理员，无保护约束
        }
        boolean keepsAdmin = newRoleCodes.contains(CODE_APP_ADMIN);
        if (keepsAdmin) {
            return; // 保留管理员，不受限
        }
        // 统计其他管理员数
        int otherAdmins = 0;
        for (Map<String, Object> m : listMembers(tenantId, appId)) {
            long uid = ((Number) m.get("userId")).longValue();
            if (uid != userId && ((List<?>) m.get("roles")).contains(CODE_APP_ADMIN)) {
                otherAdmins++;
            }
        }
        if (otherAdmins == 0) {
            throw new BizException("APP_ADMIN_REQUIRED", "不能移除最后一名应用管理员");
        }
    }

    private void notifySeatChanged(long tenantId) {
        if (seatGuard != null) {
            SeatGrantGuard guard = seatGuard.getIfAvailable();
            if (guard != null) {
                guard.onSeatChanged(tenantId);
            }
        }
    }
}