package com.schema.app.application;

import com.schema.app.domain.model.App;
import com.schema.app.domain.model.NavVersionConflictException;
import com.schema.app.domain.repository.AppRepository;
import com.schema.iam.application.AppRoleService;
import com.schema.platform.common.json.Json;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 应用生命周期服务（13BE §3/§A.1/§A.2 导航部分）。
 *
 * <p>应用成员管理在 IAM 侧（AppRoleService）——本服务聚焦应用本体：
 * CRUD、归档/恢复、删除确认（precheck + confirmValue 高摩擦二次确认）、
 * 导航树（结构校验 + 页面归属校验 + 乐观并发）、工作台卡片墙（myRole 口径）。
 *
 * <p>鉴权口径（03BE §5 + 13BE §3.1）：写操作与详情走 requireAppAdmin 闸
 * （本应用 app_admin 或 org:manage 平台管理员兜底）；列表按成员可见性过滤（无角色不出卡片墙）。
 */
@Service
public class AppService {

    /** 应用数配额（13BE §3.4：默认 50）。 */
    private static final long APP_QUOTA = 50;

    /** 导航树最大深度/数量护栏。 */
    private static final int NAV_MAX_NODES = 200;

    private final AppRepository apps;
    private final AppRoleService appRoles;
    private final AppPageRef pageRef;

    public AppService(AppRepository apps, AppRoleService appRoles, AppPageRef pageRef) {
        this.apps = apps;
        this.appRoles = appRoles;
        this.pageRef = pageRef;
    }

    // ---------- §A.1 生命周期 ----------

    /** 创建应用（13BE §A.1）：初始化默认角色 + 创建者自动成为应用管理员。
     *  权限闸（PRD07 §4）：应用创建 = 租户管理员（org:manage 持有者）。 */
    @Transactional
    public Map<String, Object> create(String name, Long iconFileId, String description,
            String themeJson, String ip, String ua) {
        TenantInfo ctx = TenantContext.get();
        appRoles.requireTenantAdminForAppCreate(ctx.tenantId(), ctx.operatorId());
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("应用名称必填");
        }
        if (name.length() > 64) {
            throw new IllegalArgumentException("应用名称超长（≤64）");
        }
        // 配额并发控制：事务内锁锚点（串行化同租户并发创建，防竞态突破上限）
        apps.lockQuotaAnchor(ctx.tenantId());
        if (apps.existsByName(ctx.tenantId(), name)) {
            throw new BizException("APP_NAME_DUPLICATED", "应用名称已存在: " + name);
        }
        if (apps.countByTenant(ctx.tenantId()) >= APP_QUOTA) {
            throw new BizException("APP_LIMIT_EXCEEDED", "应用数已达配额上限");
        }
        if (themeJson != null && !themeJson.isBlank() && !isValidJson(themeJson)) {
            throw new IllegalArgumentException("theme 必须为 JSON 对象");
        }
        App app = App.create(ctx.tenantId(), name.trim(), iconFileId, description, themeJson, ctx.operatorId());
        long appId = apps.insert(app);
        appRoles.initDefaultRoles(ctx.tenantId(), appId);
        if (ctx.operatorId() > 0) {
            appRoles.grantCreatorAdmin(ctx.tenantId(), appId, ctx.operatorId(), ip, ua);
        }
        return Map.of("appId", appId);
    }

    /** 工作台卡片墙（13BE §A.1）：{list:[{id, name, icon, description, myRole, status}]}；按 myRole 过滤可见性。 */
    public Map<String, Object> list(String keyword, boolean includeArchived) {
        TenantInfo ctx = TenantContext.get();
        List<Map<String, Object>> list = new ArrayList<>();
        for (App a : apps.listByTenant(ctx.tenantId(), keyword, includeArchived)) {
            List<String> myRoles = ctx.operatorId() > 0
                    ? appRoles.myRoleCodes(ctx.tenantId(), a.id(), ctx.operatorId())
                    : List.of();
            // 可见性（PRD 07 §2.3）：成员（持任一应用角色）可见；无角色则不出现在卡片墙
            if (myRoles.isEmpty()) {
                continue;
            }
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", a.id());
            item.put("name", a.name());
            item.put("icon", a.iconFileId());
            item.put("description", a.description());
            item.put("myRole", myRoles);
            item.put("status", a.status().name());
            item.put("navVersion", a.navVersion());
            list.add(item);
        }
        return Map.of("list", list);
    }

    /** 应用详情（13BE §A.1 隐含：设置页数据源）；须为应用管理员（防同租户越权枚举）。 */
    public Map<String, Object> detail(long appId) {
        TenantInfo ctx = TenantContext.get();
        App a = load(ctx.tenantId(), appId);
        appRoles.requireAppAdmin(ctx.tenantId(), appId, ctx.operatorId());
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("id", a.id());
        resp.put("name", a.name());
        resp.put("icon", a.iconFileId());
        resp.put("description", a.description());
        resp.put("theme", a.themeJson());
        resp.put("navVersion", a.navVersion());
        resp.put("status", a.status().name());
        resp.put("createdAt", a.createdAt() == null ? null : a.createdAt().toString());
        return resp;
    }

    /** 更新基本信息（13BE §A.1：改名即时生效）；须为应用管理员。 */
    @Transactional
    public void update(long appId, String name, Long iconFileId, String description, String themeJson) {
        TenantInfo ctx = TenantContext.get();
        App a = load(ctx.tenantId(), appId);
        appRoles.requireAppAdmin(ctx.tenantId(), appId, ctx.operatorId());
        if (a.status() != App.Status.ACTIVE && a.status() != App.Status.ARCHIVED) {
            throw new BizException("APP_NOT_EDITABLE", "应用状态不允许编辑");
        }
        if (name != null) {
            if (name.isBlank() || name.length() > 64) {
                throw new IllegalArgumentException("应用名称非法（1-64 字符）");
            }
            if (!name.equals(a.name()) && apps.existsByName(ctx.tenantId(), name)) {
                throw new BizException("APP_NAME_DUPLICATED", "应用名称已存在: " + name);
            }
        }
        if (themeJson != null && !themeJson.isBlank() && !isValidJson(themeJson)) {
            throw new IllegalArgumentException("theme 必须为 JSON 对象");
        }
        apps.updateProfile(appId, ctx.tenantId(),
                name != null ? name.trim() : a.name(),
                iconFileId != null ? iconFileId : a.iconFileId(),
                description != null ? description : a.description(),
                themeJson != null ? themeJson : a.themeJson());
    }

    /** 归档（13BE §A.1：全部资源只读，运行时访问保留）；须为应用管理员。 */
    @Transactional
    public void archive(long appId, String ip, String ua) {
        TenantInfo ctx = TenantContext.get();
        App a = load(ctx.tenantId(), appId);
        appRoles.requireAppAdmin(ctx.tenantId(), appId, ctx.operatorId());
        a.archive();
        apps.updateStatus(appId, ctx.tenantId(), App.Status.ARCHIVED.name(), null);
        audit(ctx, appId, "APP_ARCHIVE", ip, ua);
    }

    /** 恢复编辑（13BE §A.1）；须为应用管理员。 */
    @Transactional
    public void restore(long appId, String ip, String ua) {
        TenantInfo ctx = TenantContext.get();
        App a = load(ctx.tenantId(), appId);
        appRoles.requireAppAdmin(ctx.tenantId(), appId, ctx.operatorId());
        if (a.status() != App.Status.ARCHIVED) {
            throw new BizException("APP_NOT_ARCHIVED", "应用未处于归档态");
        }
        apps.updateStatus(appId, ctx.tenantId(), App.Status.ACTIVE.name(), null);
        audit(ctx, appId, "APP_RESTORE", ip, ua);
    }

    /**
     * 删除预检查（13BE §3.1 P1 降级前置）：返回影响面清单 + 确认要求（输入完整应用名）。
     * 前端展示清单后要求用户输入应用名，DELETE 请求携带 confirmValue 比对。
     */
    public Map<String, Object> deletePrecheck(long appId) {
        TenantInfo ctx = TenantContext.get();
        App a = load(ctx.tenantId(), appId);
        appRoles.requireAppAdmin(ctx.tenantId(), appId, ctx.operatorId());
        Map<String, Object> impact = pageRef.impactOf(appId, ctx.tenantId());
        impact.put("appName", a.name());
        impact.put("members", appRoles.listMembers(ctx.tenantId(), appId).size());
        return Map.of("appId", appId, "impact", impact, "confirmField", "name");
    }

    /**
     * 删除（P1 降级，13BE §3.1）：归档式删除——高摩擦确认（confirmValue=完整应用名等值比对，
     * 与元数据域 TYPE_MODEL_NAME 同构）+ 影响面清单（precheck 展示）+ 直接置 DELETING + 审计。
     */
    @Transactional
    public Map<String, Object> delete(long appId, String confirmValue, String ip, String ua) {
        TenantInfo ctx = TenantContext.get();
        App a = load(ctx.tenantId(), appId);
        appRoles.requireAppAdmin(ctx.tenantId(), appId, ctx.operatorId());
        if (confirmValue == null || !confirmValue.trim().equals(a.name())) {
            throw new BizException("APP_DELETE_CONFIRM_REQUIRED",
                    "删除确认失败：请输入完整应用名「" + a.name() + "」确认");
        }
        a.markDeleting();
        apps.updateStatus(appId, ctx.tenantId(), App.Status.DELETING.name(), a.deletedAt());
        Map<String, Object> impact = pageRef.impactOf(appId, ctx.tenantId());
        audit(ctx, appId, "APP_DELETE", Map.of("impact", impact), ip, ua);
        return Map.of("appId", appId, "impact", impact);
    }

    // ---------- §A.2 导航树 ----------

    /**
     * 导航树读取（13BE §3.3）：运行时消费 = 服务端按权限过滤（filtered=true，登录态即可——
     * 过滤本身即鉴权，未授权节点整枝剪除）；设计器消费 = 全量（须为应用管理员）。
     */
    public Map<String, Object> getNav(long appId, boolean filtered) {
        TenantInfo ctx = TenantContext.get();
        App a = load(ctx.tenantId(), appId);
        if (!filtered) {
            appRoles.requireAppAdmin(ctx.tenantId(), appId, ctx.operatorId());
        }
        List<Object> tree = Json.readList(a.navTreeJson());
        if (tree == null) {
            tree = new ArrayList<>();
        }
        if (filtered) {
            tree = pageRef.filterNavTree(tree, ctx.tenantId(), appId, ctx.operatorId());
        }
        return Map.of("tree", tree, "version", a.navVersion());
    }

    /** 导航树保存（13BE §3.3）：结构校验 + PAGE 归属校验 + 乐观并发（409 NAV_VERSION_CONFLICT）；须为应用管理员。 */
    @Transactional
    public Map<String, Object> saveNav(long appId, List<Object> tree, int baseVersion) {
        TenantInfo ctx = TenantContext.get();
        App a = load(ctx.tenantId(), appId);
        appRoles.requireAppAdmin(ctx.tenantId(), appId, ctx.operatorId());
        if (a.status() != App.Status.ACTIVE) {
            throw new BizException("APP_NOT_EDITABLE", "仅 ACTIVE 应用可编辑导航");
        }
        validateNavTree(tree, ctx.tenantId(), appId, 0, new int[]{0}, new HashSet<>());
        a.updateNavTree(Json.write(tree), baseVersion);   // 领域内版本比对（内存）
        int rows = apps.updateNavTree(appId, ctx.tenantId(), a.navTreeJson(), baseVersion, a.navVersion());
        if (rows == 0) {
            throw new NavVersionConflictException(baseVersion, rows);
        }
        return Map.of("version", a.navVersion());
    }

    // ---------- 内部 ----------

    private void audit(TenantInfo ctx, long appId, String action, String ip, String ua) {
        audit(ctx, appId, action, Map.of(), ip, ua);
    }

    private void audit(TenantInfo ctx, long appId, String action, Map<String, Object> detail,
            String ip, String ua) {
        appRoles.auditAppEvent(ctx.tenantId(), ctx.operatorId(), appId, action, detail, ip, ua);
    }

    private App load(long tenantId, long appId) {
        return apps.findByIdAndTenant(appId, tenantId)
                .orElseThrow(() -> new BizException("APP_NOT_FOUND", "应用不存在"));
    }

    private static boolean isValidJson(String s) {
        try {
            Json.parse(s);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 导航树结构校验（13BE §3.3）：
     * 节点形态 {id, type: PAGE|GROUP|LINK, label, refId?, url?, children?}；
     * PAGE 节点 refId 必须为本应用 ACTIVE 页面（强校验）；
     * 节点 id 全树唯一（防重复 key 渲染错乱与路由歧义）；
     * LINK url 仅允许 http(s)（防 javascript: 等注入向量——运行时直出 <a href>）。
     */
    private void validateNavTree(List<Object> tree, long tenantId, long appId, int depth,
            int[] counter, Set<String> seenIds) {
        if (depth > 3) {
            throw new IllegalArgumentException("导航树层级超过 3 层");
        }
        for (Object nodeObj : tree) {
            if (++counter[0] > NAV_MAX_NODES) {
                throw new IllegalArgumentException("导航树节点数超过上限 " + NAV_MAX_NODES);
            }
            if (!(nodeObj instanceof Map<?, ?> raw)) {
                throw new IllegalArgumentException("导航节点必须为对象");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> node = (Map<String, Object>) raw;
            String id = str(node.get("id"));
            if (isBlank(id) || !seenIds.add(id)) {
                throw new IllegalArgumentException("导航节点 id 必填且全树唯一: " + id);
            }
            String type = str(node.get("type"));
            if (type == null || (!"PAGE".equals(type) && !"GROUP".equals(type) && !"LINK".equals(type))) {
                throw new IllegalArgumentException("导航节点 type 必须为 PAGE/GROUP/LINK");
            }
            if (isBlank(str(node.get("label")))) {
                throw new IllegalArgumentException("导航节点 label 必填");
            }
            switch (type) {
                case "PAGE" -> {
                    Long refId = longOrNull(node.get("refId"));
                    if (refId == null) {
                        throw new IllegalArgumentException("PAGE 节点 refId 必填");
                    }
                    if (!pageRef.isPageOfApp(tenantId, appId, refId)) {
                        throw new BizException("NAV_PAGE_NOT_FOUND",
                                "导航引用页面不属于本应用或非 ACTIVE: " + refId);
                    }
                }
                case "GROUP" -> {
                    List<Object> children = childrenOf(node.get("children"));
                    if (children.isEmpty()) {
                        throw new IllegalArgumentException("GROUP 节点 children 不能为空");
                    }
                    validateNavTree(children, tenantId, appId, depth + 1, counter, seenIds);
                }
                case "LINK" -> {
                    String url = str(node.get("url"));
                    if (isBlank(url)) {
                        throw new IllegalArgumentException("LINK 节点 url 必填");
                    }
                    String lower = url.trim().toLowerCase();
                    if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
                        throw new IllegalArgumentException("LINK 节点 url 仅允许 http(s) 地址");
                    }
                }
                default -> {
                }
            }
        }
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    private static String str(Object v) {
        return v instanceof String s ? s : null;
    }

    private static Long longOrNull(Object v) {
        return v instanceof Number n ? n.longValue()
                : (v instanceof String s && !s.isBlank() ? Long.parseLong(s) : null);
    }

    @SuppressWarnings("unchecked")
    private static List<Object> childrenOf(Object v) {
        return v instanceof List<?> l ? (List<Object>) l : List.of();
    }
}