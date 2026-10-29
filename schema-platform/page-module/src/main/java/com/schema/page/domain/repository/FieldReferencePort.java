package com.schema.page.domain.repository;

import java.util.List;

/**
 * 字段引用登记端口（04BE §1.4 / 01BE §A.4）：page → metadata 的上下文映射。
 * 模块化单体阶段以进程内适配器落地（调 metadata 的 /internal/references 同构服务）；
 * 拆分后替换为 RPC——domain 不感知传输形态。
 */
public interface FieldReferencePort {

    /** 全量重建该页面引用（upsert 新集 + 清理已移除引用；幂等键由接收端保证）。 */
    void syncReferences(long tenantId, long pageId, Long modelId, List<String> pageRefs,
            List<String> scriptRefs);

    /** 页面删除时全清该页面引用。 */
    void clearReferences(long tenantId, long pageId);
}
