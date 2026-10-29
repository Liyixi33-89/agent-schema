package com.schema.page.application;

import com.schema.iam.domain.model.UserAccount;
import com.schema.iam.domain.repository.IamRepository;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Objects;

/**
 * 页面域权限闸门（03BE §5 接线 M4——页面管理动作逐请求判定，perms 快照仅前端消费不作数）。
 *
 * 权限点口径（03BE §3.1 资源×动作；ACTION 通配 resource_id=0）：
 * - 页面设计动作（创建/草稿保存/改名/删除）→ action:page:design 或 action:org:manage
 * - 发布/回滚 → action:app:publish 或 action:org:manage
 * - 运行时读取（/api/runtime/**）不设功能权限闸（发布页对全员可见，数据面由 M5 行级权限收口）
 *
 * 判定链与 IAM 域 requireOrgManagePerm 同构：操作者存在/ACTIVE/租户一致 → 角色实时判定。
 */
@Component
public class PagePermGate {

    static final String ORG_MANAGE = "action:org:manage";
    static final String PAGE_DESIGN = "action:page:design";
    static final String APP_PUBLISH = "action:app:publish";

    private final IamRepository iam;

    public PagePermGate(IamRepository iam) {
        this.iam = iam;
    }

    /** 页面设计动作闸门：创建/保存草稿/改名/删除。 */
    public void requireDesign(TenantInfo tenant) {
        requireAny(tenant, PAGE_DESIGN);
    }

    /** 发布/回滚闸门。 */
    public void requirePublish(TenantInfo tenant) {
        requireAny(tenant, APP_PUBLISH);
    }

    private void requireAny(TenantInfo tenant, String actionPerm) {
        Long operatorId = tenant.operatorId();
        if (operatorId == null || operatorId <= 0) {
            throw BizException.permDenied();
        }
        UserAccount operator = iam.findUserById(operatorId).orElse(null);
        if (operator == null || "DISABLED".equals(operator.status())
                || operator.tenantId() != tenant.tenantId()) {
            throw BizException.permDenied();
        }
        List<Long> roleIds = iam.findRolesOfUser(tenant.tenantId(), operatorId).stream()
                .map(r -> (Number) r.get("id"))
                .filter(Objects::nonNull)
                .map(Number::longValue)
                .toList();
        if (roleIds.isEmpty()) {
            throw BizException.permDenied();
        }
        boolean granted = iam.findPermsOfRoles(roleIds).stream().anyMatch(p -> {
            String perm = p.toPermString();
            return ORG_MANAGE.equals(perm) || actionPerm.equals(perm);
        });
        if (!granted) {
            throw BizException.permDenied();
        }
    }

    /** 当前操作者是否持发布权限（发布快照记录用，无权限抛 PERM_DENIED）。 */
    public static TenantInfo currentTenant() {
        return TenantContext.get();
    }
}
