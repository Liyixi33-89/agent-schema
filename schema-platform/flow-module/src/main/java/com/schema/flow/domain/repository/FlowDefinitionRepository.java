package com.schema.flow.domain.repository;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 流程定义仓储（DIP：领域层只依赖接口，实现见 infrastructure.persistence）。
 * 领域方法零 Spring 注解（架构规则约束）。
 */
public interface FlowDefinitionRepository {

    /** 新建定义（草稿态）。返回新 id。 */
    long insert(long tenantId, long appId, String flowKey, String name, String status,
            String flowSchemaJson, long createdBy);

    Optional<Map<String, Object>> findById(long tenantId, long id);

    Optional<Map<String, Object>> findByKey(long tenantId, long appId, String flowKey);

    List<Map<String, Object>> listByApp(long tenantId, long appId);

    /** 草稿保存：乐观锁（baseVersion 匹配才更新，返回受影响行数 0=冲突）。 */
    int updateDraft(long tenantId, long id, int baseVersion, String flowSchemaJson);

    /** 发布：置 PUBLISHED + 写入 deployment + 版本递增（返回受影响行数）。 */
    int markPublished(long tenantId, long id, int expectedVersion, int nextVersion,
            String flowSchemaJson, String deploymentId);
}