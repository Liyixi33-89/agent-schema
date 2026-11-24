package com.schema.flow.application;

import com.schema.flow.domain.FlowDtos.FlowSchema;
import com.schema.flow.domain.FlowErrors;
import com.schema.flow.domain.FlowSchemaMapper;
import com.schema.flow.domain.FlowSchemaValidator;
import com.schema.flow.domain.FlowTranspiler;
import com.schema.flow.domain.repository.FlowDefinitionRepository;
import com.schema.platform.common.json.Json;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 流程定义服务（spec 021 §3.1 / T4）。
 *
 * 状态机：DRAFT → PUBLISHED(v+1)；发布不可变（只能发新版本，不改已发布内容）。
 * 保存与发布都用乐观锁（baseVersion / version）——并发只有一个成功。
 *
 * ⚠️ 部署（Flowable deployment）由 {@link FlowDeploymentGateway} 承担：
 * 该接口在 Flowable 关闭时有空实现，因此**没有 Flowable 的环境也能跑定义 CRUD**。
 * 这是「生产默认关引擎、定义仍可维护」的实现基础。
 */
@Service
public class FlowDefinitionService {

    private static final Logger log = LoggerFactory.getLogger(FlowDefinitionService.class);

    private static final String STATUS_DRAFT = "DRAFT";
    private static final String STATUS_PUBLISHED = "PUBLISHED";

    private final FlowDefinitionRepository repo;
    private final FlowDeploymentGateway deployment;

    public FlowDefinitionService(FlowDefinitionRepository repo, FlowDeploymentGateway deployment) {
        this.repo = repo;
        this.deployment = deployment;
    }

    /** 列表（§3.1 GET /api/flows?appId=）。 */
    public Map<String, Object> list(long appId) {
        TenantInfo t = tenant();
        List<Map<String, Object>> rows = repo.listByApp(t.tenantId(), appId);
        List<Map<String, Object>> list = new ArrayList<>(rows.size());
        for (Map<String, Object> r : rows) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("id", str(r.get("id")));
            item.put("name", r.get("name"));
            item.put("flowKey", r.get("flow_key"));
            item.put("status", r.get("status"));
            item.put("version", r.get("version"));
            item.put("updatedAt", r.get("updated_at"));
            list.add(item);
        }
        return Map.of("list", list);
    }

    /**
     * 新建定义（保存即草稿）。校验不过 422 逐条错误。
     * flowKey 租户+应用内唯一——重复返回 409（不静默覆盖同名定义）。
     */
    @Transactional
    public Map<String, Object> create(long appId, String name, Object flowSchemaRaw) {
        TenantInfo t = tenant();
        FlowSchema schema = parse(flowSchemaRaw);
        // 保存期只做结构校验（不含本期节点集白名单——草稿允许后续阶段节点）
        FlowSchemaValidator.validateForSave(schema);

        String flowKey = schema.flowKey();
        Optional<Map<String, Object>> existing = repo.findByKey(t.tenantId(), appId, flowKey);
        if (existing.isPresent()) {
            throw new BizException(FlowErrors.VERSION_CONFLICT,
                    "流程标识已存在: " + flowKey,
                    Map.of("flowKey", flowKey));
        }

        String json = FlowSchemaMapper.toJson(schema);
        long id = repo.insert(t.tenantId(), appId, flowKey, isBlank(name) ? schema.name() : name,
                STATUS_DRAFT, json, t.operatorId());
        log.info("flow definition created id={} flowKey={}", id, flowKey);
        return Map.of("id", Long.toString(id));
    }

    /**
     * 保存草稿（§3.1 PUT /api/flows/{id}/draft）。
     * baseVersion 不匹配 → 409 + serverVersion（前端刷新后重试）。
     */
    @Transactional
    public Map<String, Object> saveDraft(long id, Object flowSchemaRaw, Integer baseVersion) {
        TenantInfo t = tenant();
        Map<String, Object> row = requireExisting(t.tenantId(), id);
        if (baseVersion == null) {
            throw new BizException(FlowErrors.VERSION_CONFLICT, "baseVersion 必填");
        }
        FlowSchema schema = parse(flowSchemaRaw);
        FlowSchemaValidator.validateForSave(schema);

        String json = FlowSchemaMapper.toJson(schema);
        int updated = repo.updateDraft(t.tenantId(), id, baseVersion, json);
        if (updated == 0) {
            int serverVersion = intOf(row.get("version"));
            throw new BizException(FlowErrors.VERSION_CONFLICT, "草稿版本冲突，请刷新后重试",
                    Map.of("serverVersion", serverVersion));
        }
        return Map.of("version", baseVersion + 1);
    }

    /**
     * 发布（§3.1 POST /api/flows/{id}/publish）。
     *
     * 校验链（任一失败即阻断，不产生 deployment）：
     * 1. 结构复检
     * 2. 本期节点集白名单 → 422 NODE_TYPE_NOT_SUPPORTED（逐节点）
     * 3. Transpiler 生成 BPMN XML
     * 4. Flowable 部署（若引擎关闭则抛出明确错误——不允许「发布成功但无 deployment」的假状态）
     * 5. 落库 PUBLISHED + 版本递增
     */
    @Transactional
    public Map<String, Object> publish(long id) {
        TenantInfo t = tenant();
        Map<String, Object> row = requireExisting(t.tenantId(), id);
        int currentVersion = intOf(row.get("version"));

        FlowSchema schema = FlowSchemaMapper.fromJson(String.valueOf(row.get("flow_schema")));
        FlowSchemaValidator.validateForPublish(schema);

        String bpmnXml = FlowTranspiler.transpile(schema);

        // 引擎未启用时必须明确失败：否则会出现「定义 PUBLISHED 但从未部署」的假状态，
        // 发起实例时才暴露，排查成本极高。
        if (!deployment.isAvailable()) {
            throw new BizException(FlowErrors.FLOW_DEF_NOT_PUBLISHED,
                    "流程引擎未启用（flowable.process.enabled=false），无法发布部署");
        }
        String deploymentId = deployment.deploy(schema.flowKey(), schema.flowKey() + ".bpmn20.xml", bpmnXml);

        int nextVersion = currentVersion + 1;
        int updated = repo.markPublished(t.tenantId(), id, currentVersion, nextVersion,
                FlowSchemaMapper.toJson(schema), deploymentId);
        if (updated == 0) {
            // 并发发布：另一请求已推进版本——deployment 已产生，记录以便人工清理
            log.warn("flow publish race: id={} deployment={} 未能推进版本", id, deploymentId);
            throw new BizException(FlowErrors.VERSION_CONFLICT, "发布版本冲突，请重试");
        }
        log.info("flow published id={} version={} deployment={}", id, nextVersion, deploymentId);
        return Map.of("version", nextVersion);
    }

    /** 详情（§3.1 GET /api/flows/{id}）。 */
    public Map<String, Object> detail(long id) {
        TenantInfo t = tenant();
        Map<String, Object> row = requireExisting(t.tenantId(), id);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", str(row.get("id")));
        out.put("name", row.get("name"));
        out.put("flowKey", row.get("flow_key"));
        out.put("status", row.get("status"));
        out.put("version", row.get("version"));
        // flowSchema 按 JSON 对象返回（不返回字符串——前端直接消费结构）
        out.put("flowSchema", normalizeJsonb(row.get("flow_schema")));
        return out;
    }

    /**
     * JSONB 列归一化。
     *
     * ⚠️ 实测踩坑：JDBC 读 jsonb 有时会返回 PGobject 的包装
     * {@code {"type":"jsonb","value":"<真实JSON字符串>"}}，
     * 直接透传会让前端拿到「值为字符串的对象」，无法解析。
     * 这里统一解包成 Map。
     */
    @SuppressWarnings("unchecked")
    private Object normalizeJsonb(Object raw) {
        if (raw == null) {
            return null;
        }
        // ① 驱动原始类型（PGobject）：getValue() 即真实 JSON 文本。
        //    用反射而非 import org.postgresql——应用层不依赖具体驱动（分层约束），
        //    同时 SQL 层已用 ::text 规避，这里是第二道保险。
        if (raw.getClass().getName().startsWith("org.postgresql.util.PGobject")) {
            try {
                Object v = raw.getClass().getMethod("getValue").invoke(raw);
                if (v instanceof String s) {
                    return safeReadMap(s);
                }
            } catch (ReflectiveOperationException e) {
                log.warn("PGobject.getValue() 调用失败，按原值处理");
            }
        }
        // ② 已被序列化成 {type: jsonb, value: "..."} 的形态（防御）
        if (raw instanceof Map<?, ?> m) {
            Object value = m.get("value");
            Object type = m.get("type");
            if (value instanceof String s && type != null) {
                return safeReadMap(s);
            }
            return m;
        }
        if (raw instanceof String s) {
            return safeReadMap(s);
        }
        return raw;
    }

    private Object safeReadMap(String json) {
        try {
            return Json.readMap(json);
        } catch (RuntimeException e) {
            // 兜底：解不动就返回空对象，避免详情接口整体 500
            log.warn("flow_schema 反序列化失败，返回空结构");
            return Map.of();
        }
    }

    /** 转办等未实现能力统一 501（§3.2 transfer 契约占位）。 */
    public Map<String, Object> notImplemented(String what) {
        throw new BizException(FlowErrors.NOT_IMPLEMENTED, what + " 本期未实现");
    }

    // ---------- helpers ----------

    private Map<String, Object> requireExisting(long tenantId, long id) {
        return repo.findById(tenantId, id).orElseThrow(() ->
                new BizException(FlowErrors.FLOW_DEF_NOT_FOUND, "流程定义不存在: " + id));
    }

    /**
     * 入参兼容：前端可传对象/JSON 字符串；内部调用方（含测试）可直接传 FlowSchema。
     */
    @SuppressWarnings("unchecked")
    private FlowSchema parse(Object raw) {
        if (raw == null) {
            throw new BizException(FlowErrors.SCHEMA_INVALID, "flowSchema 必填");
        }
        if (raw instanceof FlowSchema schema) {
            return schema;
        }
        if (raw instanceof String s) {
            return FlowSchemaMapper.fromJson(s);
        }
        if (raw instanceof Map<?, ?> m) {
            return FlowSchemaMapper.fromMap((Map<String, Object>) m);
        }
        throw new BizException(FlowErrors.SCHEMA_INVALID, "flowSchema 必须是对象或 JSON 字符串");
    }

    private TenantInfo tenant() {
        TenantInfo t = TenantContext.get();
        return t == null ? TenantInfo.DEFAULT : t;
    }

    private static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }

    private static int intOf(Object o) {
        if (o instanceof Number n) {
            return n.intValue();
        }
        return o == null ? 0 : Integer.parseInt(String.valueOf(o));
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }
}