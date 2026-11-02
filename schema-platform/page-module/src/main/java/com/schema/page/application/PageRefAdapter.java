package com.schema.page.application;

import com.schema.app.application.AppPageRef;
import com.schema.page.domain.repository.PageRepository;
import com.schema.iam.domain.repository.IamRepository;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * app-module 页面切口实现（13BE §3.3 导航过滤 / §3.1 影响面）。
 * 装配方向：app-module 定义接口，本类经 Spring 注入（bootstrap 组合根接线）。
 */
@Component
public class PageRefAdapter implements AppPageRef {

    private final PageRepository pages;
    private final IamRepository iam;

    public PageRefAdapter(PageRepository pages, IamRepository iam) {
        this.pages = pages;
        this.iam = iam;
    }

    @Override
    public boolean isPageOfApp(long tenantId, long appId, long pageId) {
        return pages.findByIdAndTenant(pageId, tenantId)
                .map(p -> p.appId() == appId && "ACTIVE".equals(p.status()))
                .orElse(false);
    }

    @Override
    @SuppressWarnings("unchecked")
    public List<Object> filterNavTree(List<Object> tree, long tenantId, long appId, Long userId) {
        List<Object> out = new ArrayList<>();
        List<Long> visible = null;
        for (Object nodeObj : tree) {
            if (!(nodeObj instanceof Map<?, ?> raw)) {
                continue;
            }
            Map<String, Object> node = (Map<String, Object>) raw;
            String type = node.get("type") instanceof String t ? t : null;
            if ("GROUP".equals(type)) {
                List<Object> children = node.get("children") instanceof List<?> l ? (List<Object>) l : List.of();
                List<Object> filtered = filterNavTree(children, tenantId, appId, userId);
                if (!filtered.isEmpty()) {
                    Map<String, Object> copy = new LinkedHashMap<>(node);
                    copy.put("children", filtered);
                    out.add(copy);
                }
                continue;
            }
            if ("PAGE".equals(type)) {
                if (visible == null) {
                    visible = visiblePageIds(tenantId, appId, userId);
                }
                Long refId = node.get("refId") instanceof Number n ? n.longValue() : null;
                if (refId == null || !visible.contains(refId)) {
                    continue;
                }
            }
            out.add(node);
        }
        return out;
    }

    @Override
    public Map<String, Object> impactOf(long appId, long tenantId) {
        Map<String, Object> impact = new LinkedHashMap<>();
        impact.put("pages", pages.listByApp(tenantId, appId, null).size());
        return impact;
    }

    /**
     * 用户在应用的可见页面集合（导航过滤输入，13BE §3.3 服务端过滤口径）。
     * 权限口径（03BE §3.2 + PagePermGate 注释）：运行时读取面不设功能权限闸——
     * 应用成员默认可见全部发布页；已配置 PAGE:view 行权限的页面按行精确过滤
     * （未授权用户默认拒绝，与字段级默认拒绝同构）；org:manage/page:design 持有者可见全部。
     *
     * <p>⚠️ 「已配置」判定与用户权限解耦（与字段级 hasFieldPermRows 同构）：
     * 以「本应用存在任意角色的 PAGE:view 行」为准——不得用「当前用户是否持有」推断，
     * 否则未授权用户会被误判为「未配置」而错误放行全部页面（默认放行漏洞）。
     */
    private List<Long> visiblePageIds(long tenantId, long appId, Long userId) {
        if (userId == null || userId <= 0) {
            return List.of();
        }
        List<Long> all = pages.listByApp(tenantId, appId, null).stream()
                .map(p -> p.id()).toList();
        List<Long> roleIds = iam.findRolesOfUser(tenantId, userId).stream()
                .map(r -> (Number) r.get("id"))
                .filter(Objects::nonNull)
                .map(Number::longValue)
                .toList();
        if (roleIds.isEmpty()) {
            return List.of();
        }
        List<Long> explicit = new ArrayList<>();
        boolean manageAll = false;
        for (var perm : iam.findPermsOfRoles(roleIds)) {
            if ("PAGE".equals(perm.resourceType()) && "view".equals(perm.action())) {
                explicit.add(perm.resourceId());
            }
            String s = perm.toPermString();
            if ("action:org:manage".equals(s) || "action:page:design".equals(s)) {
                manageAll = true;
            }
        }
        if (manageAll) {
            return all;
        }
        // 本应用是否配置过 PAGE:view 权限行（任意角色——与当前用户无关，默认拒绝判定输入）
        if (!iam.hasPagePermRows(tenantId, appId)) {
            return all;   // 完全未配置：应用成员默认全可见（13BE §3.3 成员默认可见）
        }
        // 已配置：按当前用户持有的行精确过滤（未授权页面整枝剪除）
        return all.stream().filter(explicit::contains).toList();
    }
}