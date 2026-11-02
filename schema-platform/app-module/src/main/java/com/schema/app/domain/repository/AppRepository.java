package com.schema.app.domain.repository;

import com.schema.app.domain.model.App;

import java.util.List;
import java.util.Optional;

/**
 * 应用仓储接口（领域层定义，基础设施层实现——DIP，后端总纲 §3）。
 * 应用成员/角色不走本仓储：复用 IAM sys_role(role_type='APP') + sys_user_role（03BE §A.3）。
 */
public interface AppRepository {

    /** 新建应用，返回自增 id。 */
    long insert(App app);

    /** 按 id 加载（不含 DELETED/DELETING）。 */
    Optional<App> findById(long appId);

    /** 租户内加载：任何跨租户读取必须失配（tenant-isolation-guard）。 */
    Optional<App> findByIdAndTenant(long appId, long tenantId);

    /** 应用列表（按 name 模糊匹配；includeArchived 供管理员）。 */
    List<App> listByTenant(long tenantId, String keyword, boolean includeArchived);

    /** 更新基本信息（名称/图标/描述/主题）。 */
    void updateProfile(long appId, long tenantId, String name, Long iconFileId, String description, String themeJson);

    /** 导航树乐观更新：WHERE id=? AND tenant_id=? AND nav_version=?；返回受影响行数（0=冲突）。 */
    int updateNavTree(long appId, long tenantId, String navTreeJson, int baseVersion, int newVersion);

    /** 逻辑归档 / 逻辑删除。 */
    void updateStatus(long appId, long tenantId, String status, java.time.OffsetDateTime deletedAt);

    /** 应用配额检查（13BE §3.4：默认 50）。 */
    long countByTenant(long tenantId);

    /**
     * 配额并发控制锚点（13BE §7 同构席位并发控制）：SELECT ... FOR UPDATE 锁租户既有 app 行。
     * 事务内「锁-计数-校验」串行化同租户并发创建，防止竞态突破配额上限。
     */
    void lockQuotaAnchor(long tenantId);

    boolean existsByName(long tenantId, String name);
}