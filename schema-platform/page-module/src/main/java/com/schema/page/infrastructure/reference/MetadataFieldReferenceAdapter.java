package com.schema.page.infrastructure.reference;

import com.schema.metadata.application.MetadataCommandService;
import com.schema.page.domain.repository.FieldReferencePort;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 引用登记适配器（进程内上下文映射）：page → metadata 的 /internal/references 同构调用。
 * 模块化单体阶段直连应用服务（禁跨模块 join 但允许依赖 interfaces 契约面的应用服务——
 * 单体收敛形态由 bootstrap 组合根背书）；拆分后换 RPC 实现，domain 端口不变。
 *
 * 引用登记失败不阻断保存（04BE §1.4：重试队列 + 告警，影响面数据允许短暂滞后）。
 */
@Component
public class MetadataFieldReferenceAdapter implements FieldReferencePort {

    private final MetadataCommandService metadata;

    public MetadataFieldReferenceAdapter(MetadataCommandService metadata) {
        this.metadata = metadata;
    }

    @Override
    public void syncReferences(long tenantId, long pageId, Long modelId, List<String> pageRefs,
            List<String> scriptRefs) {
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
        // metadata 侧按 ref_id 全清接口（01BE §A.4「页面删除同步清理」）
        metadata.clearReferencesByRefId(pageId, "PAGE", "SCRIPT");
    }
}
