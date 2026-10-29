package com.schema.page.infrastructure.reference;

import com.schema.metadata.application.MetadataCommandService;
import com.schema.page.domain.repository.FieldReferencePort;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 引用登记适配器（进程内上下文映射）：page → metadata 的 /internal/references 同构调用。
 * 模块化单体阶段直连应用服务（禁跨模块 join 但允许依赖 interfaces 契约面的应用服务——
 * 单体收敛形态由 bootstrap 组合根背书）；拆分后换 RPC 实现，domain 端口不变。
 *
 * 全量重建语义（04BE §1.4）：先清该页面引用再登记当前扫描集——
 * 否则字段引用移除/模型绑定解除后旧引用残留，precheck 影响面虚高误报。
 * 登记失败不阻断保存（影响面数据允许短暂滞后），但必须记 WARN 日志（可告警消费）。
 */
@Component
public class MetadataFieldReferenceAdapter implements FieldReferencePort {

    private static final Logger log = LoggerFactory.getLogger(MetadataFieldReferenceAdapter.class);

    private final MetadataCommandService metadata;

    /** 自代理（@Lazy selfRef——03BE §4 沉淀）：REQUIRES_NEW 必须经 Spring 代理调用，this. 直调不生效。 */
    @org.springframework.beans.factory.annotation.Autowired
    @org.springframework.context.annotation.Lazy
    private MetadataFieldReferenceAdapter selfRef;

    public MetadataFieldReferenceAdapter(MetadataCommandService metadata) {
        this.metadata = metadata;
    }

    @Override
    public void syncReferences(long tenantId, long pageId, Long modelId, List<String> pageRefs,
            List<String> scriptRefs) {
        try {
            selfRef.syncInNewTx(pageId, modelId, pageRefs, scriptRefs);
        } catch (Exception e) {
            log.warn("字段引用登记失败（不阻断保存）: pageId={} modelId={} cause={}",
                    pageId, modelId, e.getMessage());
        }
    }

    /**
     * 独立事务登记（REQUIRES_NEW）：登记异常不得把页面保存外层事务标记 rollback-only——
     * 否则「失败不阻断保存」契约失效（保存被连带回滚）。全量重建在独立事务内完成。
     */
    @org.springframework.transaction.annotation.Transactional(
            propagation = org.springframework.transaction.annotation.Propagation.REQUIRES_NEW)
    public void syncInNewTx(long pageId, Long modelId, List<String> pageRefs, List<String> scriptRefs) {
        // 全量重建：先清旧集（含模型绑定解除场景——modelId 变更时旧模型引用一并清）
        metadata.clearReferencesByRefId(pageId, "PAGE", "SCRIPT");
        if (modelId == null) {
            return; // 无绑定模型的页面（静态页/占位页）无字段引用面
        }
        for (String fieldKey : pageRefs) {
            metadata.registerReference(modelId, fieldKey, "PAGE", pageId);
        }
        for (String fieldKey : scriptRefs) {
            metadata.registerReference(modelId, fieldKey, "SCRIPT", pageId);
        }
    }

    @Override
    public void clearReferences(long tenantId, long pageId) {
        // 页面删除路径：与主事务同 COMMIT（删除必须保证引用同步清理，不允许滞后）
        metadata.clearReferencesByRefId(pageId, "PAGE", "SCRIPT");
    }
}
