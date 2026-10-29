package com.schema.metadata.domain.repository;

import com.schema.metadata.domain.model.ModelAggregate;

import java.util.List;
import java.util.Optional;

/**
 * 模型仓储接口（领域层定义，基础设施层实现——DIP，后端总纲 §3）。
 */
public interface ModelRepository {

    /** 新建模型（初始版本 v1）。 */
    long insert(ModelAggregate model);

    /** 加载聚合（含全部字段，含 DELETED）。 */
    Optional<ModelAggregate> findById(long modelId);

    /** 加载租户内聚合：任何跨租户读取必须失配（tenant-isolation-guard）。 */
    Optional<ModelAggregate> findByIdAndTenant(long modelId, long tenantId);

    /** 列表：默认过滤 DELETED；includeDeleted 供管理员。 */
    List<ModelAggregate> listByApp(long tenantId, long appId, String keyword, boolean includeDeleted);

    /** 乐观锁推进版本（WHERE current_version = base）；返回是否成功。 */
    boolean advanceVersion(long modelId, long tenantId, int baseVersion);

    /** 改名/图标。 */
    void updateProfile(long modelId, long tenantId, String name, String icon);

    /** 逻辑删除模型（status='DELETED' + deleted_at）。 */
    void markDeleted(long modelId, long tenantId);

    /** 模型数配额检查（01BE §6：默认 200）。 */
    long countByTenant(long tenantId);

    boolean existsByModelKey(long tenantId, long appId, String modelKey);

    /** 关系目标存在性（01BE §4.2 步骤 4 校验器）：租户内显式谓词，跨租户目标同判不存在。 */
    boolean existsByIdAndTenant(long modelId, long tenantId);
}
