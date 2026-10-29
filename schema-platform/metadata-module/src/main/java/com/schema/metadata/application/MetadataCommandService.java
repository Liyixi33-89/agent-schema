package com.schema.metadata.application;

import com.schema.metadata.domain.model.ChangeOp;
import com.schema.metadata.domain.model.ConfirmMode;
import com.schema.metadata.domain.model.ModelAggregate;
import com.schema.metadata.domain.model.Risk;
import com.schema.metadata.domain.repository.FieldRepository;
import com.schema.metadata.domain.repository.ModelRepository;
import com.schema.metadata.domain.repository.SchemaVersionRepository;
import com.schema.platform.common.json.Json;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 元数据应用服务（01BE §4）：两段式保存、precheck 三档、confirmToken 四元组校验、版本快照、回滚。
 * 事务边界 = 单聚合（模型）；跨聚合联动（DDL 任务/缓存广播）以事件形态预留，随 M5 落地消费方。
 */
@Service
public class MetadataCommandService {

    /** confirmToken 有效期（01BE §4.2：10 分钟）。 */
    static final Duration TOKEN_TTL = Duration.ofMinutes(10);
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final int MODEL_LIMIT = 200;

    private final ModelRepository models;
    private final FieldRepository fields;
    private final SchemaVersionRepository versions;

    public MetadataCommandService(ModelRepository models, FieldRepository fields,
            SchemaVersionRepository versions) {
        this.models = models;
        this.fields = fields;
        this.versions = versions;
    }

    // ---------- 模型 CRUD ----------

    @Transactional
    public Map<String, Object> createModel(String modelKey, String name, String icon) {
        TenantInfo tenant = TenantContext.get();
        if (models.countByTenant(tenant.tenantId()) >= MODEL_LIMIT) {
            throw new BizException("MODEL_LIMIT_EXCEEDED", "单租户模型数已达上限 " + MODEL_LIMIT);
        }
        if (models.existsByModelKey(tenant.tenantId(), tenant.appId(), modelKey)) {
            throw new BizException("MODEL_KEY_DUPLICATED", "model_key 已存在: " + modelKey);
        }
        ModelAggregate model = ModelAggregate.create(tenant, modelKey, name, icon);
        long id = models.insert(model);
        model.assignId(id);
        // 首版快照（v1 空字段集）
        snapshot(model, List.of(), tenant.operatorId(), null);
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("id", Long.toString(id));       // ID string 传输（10BE §A.1）
        resp.put("modelKey", modelKey);
        resp.put("currentVersion", 1);
        return resp;
    }

    public Map<String, Object> listModels(String keyword, boolean includeDeleted) {
        TenantInfo tenant = TenantContext.get();
        List<Map<String, Object>> list = new ArrayList<>();
        for (ModelAggregate m : models.listByApp(tenant.tenantId(), tenant.appId(), keyword, includeDeleted)) {
            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("id", Long.toString(m.id()));
            summary.put("modelKey", m.modelKey());
            summary.put("name", m.name());
            summary.put("icon", m.icon());
            summary.put("status", m.status());
            summary.put("currentVersion", m.currentVersion());
            list.add(summary);
        }
        return Map.of("list", list, "total", list.size());
    }

    public Map<String, Object> getModel(long modelId) {
        ModelAggregate model = loadForTenant(modelId);
        List<Map<String, Object>> fieldList = new ArrayList<>();
        for (ModelAggregate.FieldDef f : model.allFields()) {
            fieldList.add(fieldView(f, true));
        }
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("id", Long.toString(model.id()));
        resp.put("modelKey", model.modelKey());
        resp.put("name", model.name());
        resp.put("icon", model.icon());
        resp.put("status", model.status());
        resp.put("currentVersion", model.currentVersion());
        resp.put("fields", fieldList);
        return resp;
    }

    @Transactional
    public void updateModel(long modelId, String name, String icon) {
        TenantInfo tenant = TenantContext.get();
        ModelAggregate model = loadForTenant(modelId);
        models.updateProfile(model.id(), tenant.tenantId(), name, icon);
    }

    /** 删除模型 precheck（01BE §4.1「走确认协议」+ §4.3 高风险档）：删模型固定 TYPE_MODEL_NAME。 */
    @Transactional
    public Map<String, Object> deleteModelPrecheck(long modelId) {
        TenantInfo tenant = TenantContext.get();
        ModelAggregate model = loadForTenant(modelId);
        List<Risk> risks = analyzeImpact(tenant, model, List.of());
        // 全模型引用面：该模型全部字段被谁引用（复用影响面聚合路径）
        List<String> allKeys = new ArrayList<>();
        for (var f : model.activeFields()) {
            allKeys.add(f.fieldKey());
        }
        for (Map<String, Object> ref : versions.findReferences(tenant.tenantId(), model.id(), allKeys)) {
            String refType = (String) ref.get("ref_type");
            String severity = switch (refType) {
                case "PAGE", "SCRIPT", "COMPUTED" -> Risk.HIGH;
                default -> Risk.MEDIUM;
            };
            risks.add(new Risk(refType + "_REF", asLong(ref.get("ref_id")), null, null, null, null, severity));
        }

        String token = newToken();
        // 绑定串带模型名摘要：防止 token 被挪用到改名后的其他模型（复用 meta_confirm_token 基建）
        versions.issueToken(token, modelId, "delete-model:" + model.name(), model.currentVersion(),
                ConfirmMode.TYPE_MODEL_NAME.code(), OffsetDateTime.now().plus(TOKEN_TTL));

        Map<String, Object> resp = new LinkedHashMap<>();
        List<Map<String, Object>> riskMaps = new ArrayList<>();
        for (Risk r : risks) {
            riskMaps.add(r.toMap());
        }
        resp.put("risks", riskMaps);
        resp.put("maxSeverity", Risk.maxSeverity(risks));
        resp.put("confirmMode", ConfirmMode.TYPE_MODEL_NAME.code());
        resp.put("confirmToken", token);
        return resp;
    }

    /** 删除模型确认提交（01BE §4.3）：confirmValue = 模型名原文，token 一次性消费。 */
    @Transactional
    public void deleteModelConfirm(long modelId, String confirmToken, String confirmValue) {
        TenantInfo tenant = TenantContext.get();
        ModelAggregate model = loadForTenant(modelId);
        // token 先校验再幂等返回：已删除模型上重放已消费 token 必须拒绝（而非静默成功）
        if (confirmValue == null || !confirmValue.equals(model.name())) {
            throw BizException.confirmTokenInvalid("confirmValue 与模型名不一致");
        }
        if (!versions.consumeToken(confirmToken, model.id(), "delete-model:" + model.name(),
                model.currentVersion())) {
            throw BizException.confirmTokenInvalid("token 未签发/已消费/绑定不一致/已过期");
        }
        if (model.deletedModel()) {
            return; // token 有效前提下的幂等返回（并发重复提交场景）
        }
        models.markDeleted(model.id(), tenant.tenantId());
        // 物理表改名 biz_model_{id}_archived 由 DDL 执行器消费删除事件执行（M5 联调，本 spec 只发事件形态）
    }

    // ---------- 两段式保存 ----------

    /**
     * precheck（01BE §4.2/§4.5）：影响面聚合 + confirmMode 分档 + token 签发。
     */
    @Transactional
    public Map<String, Object> precheck(long modelId, List<ChangeOp> changes) {
        TenantInfo tenant = TenantContext.get();
        ModelAggregate model = loadForTenant(modelId);
        validateChanges(tenant, model, changes);

        List<Risk> risks = analyzeImpact(tenant, model, changes);
        ConfirmMode mode = decideConfirmMode(model, changes, risks);

        String token = newToken();
        String bindingHash = bindingHash(changes);
        versions.issueToken(token, modelId, bindingHash, model.currentVersion(), mode.code(),
                OffsetDateTime.now().plus(TOKEN_TTL));

        Map<String, Object> resp = new LinkedHashMap<>();
        List<Map<String, Object>> riskMaps = new ArrayList<>();
        for (Risk r : risks) {
            riskMaps.add(r.toMap());
        }
        resp.put("risks", riskMaps);
        resp.put("maxSeverity", Risk.maxSeverity(risks));
        resp.put("confirmMode", mode.code());
        resp.put("confirmToken", token);
        return resp;
    }

    /**
     * 保存（01BE §4.2 事务流程）：乐观锁 → token 幂等消费 → 逐条应用 → 校验器 → 快照落库。
     */
    @Transactional
    public Map<String, Object> saveSchema(long modelId, List<ChangeOp> changes, int baseVersion,
            String confirmToken, String confirmValue) {
        TenantInfo tenant = TenantContext.get();
        ModelAggregate model = loadForTenant(modelId);

        // 1. 乐观锁：baseVersion 必须等于当前版本
        if (model.currentVersion() != baseVersion) {
            throw BizException.versionConflict(model.currentVersion());
        }

        // 2. token 校验（绑定 changes 摘要 + baseVersion）；TYPE_MODEL_NAME 时 confirmValue 等值比对
        String bindingHash = bindingHash(changes);
        String modeCode = versions.findTokenMode(confirmToken)
                .orElseThrow(() -> BizException.confirmTokenInvalid("token 未签发/已消费/已过期"));
        if (ConfirmMode.TYPE_MODEL_NAME.code().equals(modeCode)) {
            if (confirmValue == null || !confirmValue.equals(model.name())) {
                throw BizException.confirmTokenInvalid("confirmValue 与模型名不一致");
            }
        }
        if (!versions.consumeToken(confirmToken, model.id(), bindingHash, baseVersion)) {
            throw BizException.confirmTokenInvalid("token 未签发/已消费/绑定不一致/已过期");
        }

        // 3. 逐条应用 changes（内存构建新字段集合）
        validateChanges(tenant, model, changes);
        int targetVersion = baseVersion + 1;
        List<Map<String, Object>> diff = new ArrayList<>();
        List<ModelAggregate.FieldDef> promoted = new ArrayList<>();
        OffsetDateTime now = OffsetDateTime.now();
        for (ChangeOp change : changes) {
            switch (change) {
                case ChangeOp.AddField add -> {
                    model.addNewField(add.fieldKey(), add.label(), add.fieldType(), add.required(),
                            add.uniqueFlag(), add.indexed(), add.defaultValue(), add.validators(),
                            add.enumOptions(), add.relationConfig(), add.computedConfig(), add.sortOrder(),
                            targetVersion);
                    diff.add(Map.of("op", "ADD_FIELD", "fieldKey", add.fieldKey()));
                }
                case ChangeOp.ModifyField mod -> {
                    applyModify(model, mod, targetVersion);
                    diff.add(Map.of("op", "MODIFY_FIELD", "fieldKey", mod.fieldKey()));
                }
                case ChangeOp.DeleteField del -> {
                    model.deleteField(del.fieldKey(), now);
                    diff.add(Map.of("op", "DELETE_FIELD", "fieldKey", del.fieldKey()));
                }
                case ChangeOp.PromoteColumn pro -> {
                    ModelAggregate.FieldDef f = model.findField(pro.fieldKey())
                            .orElseThrow(() -> new BizException("FIELD_NOT_FOUND", "字段不存在: " + pro.fieldKey()));
                    model.modifyField(pro.fieldKey(), null, null, null, true, null, null, null, null, null,
                            null, targetVersion);
                    diff.add(Map.of("op", "PROMOTE_COLUMN", "fieldKey", pro.fieldKey()));
                    promoted.add(f);
                }
            }
        }

        // 4. 校验器：循环依赖检测（计算字段依赖图）
        List<String> cycle = model.detectCircularDependency();
        if (!cycle.isEmpty()) {
            throw BizException.circularDependency(cycle);
        }

        // 5-6. 元数据落库 + 快照
        persistChanges(model, tenant, changes, targetVersion);
        registerComputedReferences(tenant, model);
        snapshot(model, diff, tenant.operatorId(), null);

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("version", targetVersion);
        List<Map<String, Object>> tasks = new ArrayList<>();
        for (ModelAggregate.FieldDef f : collectPendingPromotions(model)) {
            tasks.add(Map.of("fieldKey", f.fieldKey()));
        }
        resp.put("promotedTasks", tasks);
        return resp;
    }

    // ---------- 版本与回滚 ----------

    public Map<String, Object> listVersions(long modelId) {
        loadForTenant(modelId);
        List<Map<String, Object>> list = new ArrayList<>();
        for (var v : versions.listVersions(modelId, 100)) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("version", v.version());
            item.put("diffSummary", Json.readList(v.diffJson()));
            item.put("operator", Long.toString(v.operatorId()));
            item.put("createdAt", v.createdAt() == null ? null : v.createdAt().toString());
            if (v.rollbackFrom() != null) {
                item.put("rollbackFrom", v.rollbackFrom());
            }
            list.add(item);
        }
        return Map.of("list", list);
    }

    public Map<String, Object> getVersion(long modelId, int version) {
        loadForTenant(modelId);
        var snapshot = versions.findVersion(modelId, version)
                .orElseThrow(() -> BizException.notFound("版本 v" + version));
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("version", snapshot.version());
        resp.put("snapshot", Json.readMap(snapshot.snapshotJson()));
        return resp;
    }

    /** 回滚 precheck（01BE §4.3）：独立 token 绑定 targetVersion。 */
    @Transactional
    public Map<String, Object> rollbackPrecheck(long modelId, int targetVersion) {
        TenantInfo tenant = TenantContext.get();
        ModelAggregate model = loadForTenant(modelId);
        var target = versions.findVersion(modelId, targetVersion)
                .orElseThrow(() -> BizException.notFound("目标版本 v" + targetVersion));

        // risks：targetVersion → 当前版本间的字段删除/类型差异
        List<Risk> risks = rollbackRisks(tenant, model, target.snapshotJson());

        String token = newToken();
        versions.issueToken(token, modelId, "rollback:" + targetVersion, targetVersion,
                ConfirmMode.TYPE_MODEL_NAME.code(), OffsetDateTime.now().plus(TOKEN_TTL));

        Map<String, Object> resp = new LinkedHashMap<>();
        List<Map<String, Object>> riskMaps = new ArrayList<>();
        for (Risk r : risks) {
            riskMaps.add(r.toMap());
        }
        resp.put("risks", riskMaps);
        resp.put("maxSeverity", Risk.maxSeverity(risks));
        resp.put("confirmMode", ConfirmMode.TYPE_MODEL_NAME.code());
        resp.put("confirmToken", token);
        return resp;
    }

    /**
     * 回滚（01BE §4.4）：读取快照 → 与当前字段集合 diff → 以变更集形式走同一保存流程；
     * rollback_from 标记；数据零操作。token 绑定 targetVersion（而非 changes）。
     */
    @Transactional
    public Map<String, Object> rollback(long modelId, int targetVersion, String confirmToken,
            String confirmValue) {
        TenantInfo tenant = TenantContext.get();
        ModelAggregate model = loadForTenant(modelId);
        var target = versions.findVersion(modelId, targetVersion)
                .orElseThrow(() -> BizException.notFound("目标版本 v" + targetVersion));

        if (model.currentVersion() == targetVersion) {
            throw new BizException("ROLLBACK_NOOP", "当前版本即目标版本");
        }
        // 回滚统一按高风险处理：confirmValue 必须与模型名等值（01BE §4.3）
        if (confirmValue == null || !confirmValue.equals(model.name())) {
            throw BizException.confirmTokenInvalid("confirmValue 与模型名不一致");
        }
        if (!versions.consumeToken(confirmToken, model.id(), "rollback:" + targetVersion, targetVersion)) {
            throw BizException.confirmTokenInvalid("token 未签发/已消费/绑定不一致/已过期");
        }

        // 快照 → 变更集（与当前活跃字段集合 diff）
        List<ChangeOp> changes = diffSnapshotToChanges(model, Json.readMap(target.snapshotJson()));

        int baseVersion = model.currentVersion();
        int newVersion = baseVersion + 1;
        OffsetDateTime now = OffsetDateTime.now();
        List<Map<String, Object>> diff = new ArrayList<>();
        for (ChangeOp change : changes) {
            switch (change) {
                case ChangeOp.AddField add -> {
                    // 复活草稿态（不自动 promote，01BE §4.3）
                    model.resurrectFieldDraft(add.fieldKey(), add.label(), add.fieldType(), add.required(),
                            add.uniqueFlag(), add.indexed(), add.defaultValue(), add.validators(),
                            add.enumOptions(), add.relationConfig(), add.computedConfig(), add.sortOrder(),
                            newVersion);
                    diff.add(Map.of("op", "RESURRECT_FIELD", "fieldKey", add.fieldKey()));
                }
                case ChangeOp.ModifyField mod -> {
                    applyModify(model, mod, newVersion);
                    diff.add(Map.of("op", "MODIFY_FIELD", "fieldKey", mod.fieldKey()));
                }
                case ChangeOp.DeleteField del -> {
                    model.deleteField(del.fieldKey(), now);
                    diff.add(Map.of("op", "DELETE_FIELD", "fieldKey", del.fieldKey()));
                }
                default -> {
                    throw new IllegalStateException("回滚变更集不该出现 " + change.op());
                }
            }
        }

        List<String> cycle = model.detectCircularDependency();
        if (!cycle.isEmpty()) {
            throw BizException.circularDependency(cycle);
        }

        persistRollback(model, tenant, changes, newVersion);
        registerComputedReferences(tenant, model);
        snapshot(model, diff, tenant.operatorId(), targetVersion);

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("version", newVersion);
        return resp;
    }

    // ---------- 引用登记（/internal/references，M4.3 消费） ----------

    @Transactional
    public void registerReference(long modelId, String fieldKey, String refType, long refId) {
        TenantInfo tenant = TenantContext.get();
        loadForTenant(modelId);
        versions.upsertReference(tenant.tenantId(), modelId, fieldKey, refType, refId);
    }

    /** 页面删除时全清该页面引用（01BE §A.4「页面删除同步清理」；refTypes 限定调用方域）。 */
    @Transactional
    public void clearReferencesByRefId(long refId, String... refTypes) {
        TenantInfo tenant = TenantContext.get();
        for (String refType : refTypes) {
            versions.deleteReferencesByRefId(tenant.tenantId(), refId, refType);
        }
    }

    // ---------- 内部 ----------

    private ModelAggregate loadForTenant(long modelId) {
        TenantInfo tenant = TenantContext.get();
        ModelAggregate model = models.findByIdAndTenant(modelId, tenant.tenantId())
                .orElseThrow(() -> BizException.notFound("模型 " + modelId));
        for (ModelAggregate.FieldDef f : fields.loadAll(modelId)) {
            model.loadField(f);
        }
        return model;
    }

    /** 变更合法性前置校验：存在性 / field_key/field_type 冻结 / 配置类型相关性（01BE §4.2 步骤 3-4）。 */
    private void validateChanges(TenantInfo tenant, ModelAggregate model, List<ChangeOp> changes) {
        for (ChangeOp change : changes) {
            switch (change) {
                case ChangeOp.ModifyField mod -> {
                    if (mod.patch().containsKey("fieldKey") || mod.patch().containsKey("fieldType")
                            || mod.patch().containsKey("field_key") || mod.patch().containsKey("field_type")
                            || mod.patch().containsKey("type")) {
                        throw BizException.fieldKeyImmutable();
                    }
                    ModelAggregate.FieldDef f = model.findField(mod.fieldKey())
                            .orElseThrow(() -> new BizException("FIELD_NOT_FOUND", "字段不存在: " + mod.fieldKey()));
                    validateFieldConfig(tenant, f.fieldType(), mod.patch());
                }
                case ChangeOp.DeleteField del -> model.findField(del.fieldKey())
                        .orElseThrow(() -> new BizException("FIELD_NOT_FOUND", "字段不存在: " + del.fieldKey()));
                case ChangeOp.AddField add -> {
                    if (model.findField(add.fieldKey()).isPresent()) {
                        throw new BizException("FIELD_KEY_DUPLICATED", "字段已存在: " + add.fieldKey());
                    }
                    validateFieldConfig(tenant, add.fieldType(), add.field());
                }
                case ChangeOp.PromoteColumn pro -> model.findField(pro.fieldKey())
                        .orElseThrow(() -> new BizException("FIELD_NOT_FOUND", "字段不存在: " + pro.fieldKey()));
            }
        }
    }

    /**
     * 配置类型相关性校验（01BE §4.2 步骤 4）：枚举值引用、关系目标存在、计算配置结构——
     * 规则与前端 validate.ts 同构（双端同判）；MODIFY 场景 patch 为整体替换值，按替换后形态校验。
     */
    private void validateFieldConfig(TenantInfo tenant, String fieldType, Map<String, Object> config) {
        Object enumOptions = config.get("enumOptions");
        if (enumOptions != null) {
            if (!"enum".equals(fieldType)) {
                throw BizException.fieldConfigInvalid("enumOptions 仅 enum 类型字段可配置（当前 " + fieldType + "）");
            }
            if (!(enumOptions instanceof List<?> opts)) {
                throw BizException.fieldConfigInvalid("enumOptions 必须为数组");
            }
            java.util.Set<String> values = new java.util.HashSet<>();
            for (Object o : opts) {
                if (!(o instanceof Map<?, ?> m) || !(m.get("value") instanceof String v) || v.isBlank()
                        || !(m.get("label") instanceof String)
                        || !("ACTIVE".equals(m.get("status")) || "DEPRECATED".equals(m.get("status")))) {
                    throw BizException.fieldConfigInvalid("enumOptions[].{value,label,status} 结构非法");
                }
                if (!values.add(v)) {
                    throw BizException.fieldConfigInvalid("enumOptions[].value 重复: " + v);
                }
            }
        }
        Object relation = config.get("relation");
        if (relation != null) {
            if (!"relation".equals(fieldType)) {
                throw BizException.fieldConfigInvalid("relation 仅 relation 类型字段可配置（当前 " + fieldType + "）");
            }
            if (!(relation instanceof Map<?, ?> rm) || !(rm.get("targetModelId") instanceof String target)
                    || target.isBlank()) {
                throw BizException.fieldConfigInvalid("relation.targetModelId 结构非法");
            }
            if (!List.of("1:1", "1:n", "n:n").contains(rm.get("cardinality"))
                    || !List.of("FORBID", "SET_NULL", "CASCADE_SOFT_DELETE").contains(rm.get("cascade"))) {
                throw BizException.fieldConfigInvalid("relation.{cardinality,cascade} 取值非法");
            }
            long targetId;
            try {
                targetId = Long.parseLong(target);
            } catch (NumberFormatException e) {
                throw BizException.fieldConfigInvalid("relation.targetModelId 必须为模型 ID");
            }
            if (!models.existsByIdAndTenant(targetId, tenant.tenantId())) {
                throw BizException.relationTargetNotFound(target);
            }
        }
        Object computed = config.get("computed");
        if (computed != null) {
            if (!"computed".equals(fieldType)) {
                throw BizException.fieldConfigInvalid("computed 仅 computed 类型字段可配置（当前 " + fieldType + "）");
            }
            if (!(computed instanceof Map<?, ?> cm) || !(cm.get("expr") instanceof Map<?, ?> em)
                    || !"expr".equals(em.get("kind")) || !(em.get("source") instanceof String src)
                    || src.isBlank()) {
                throw BizException.fieldConfigInvalid("computed.{expr.kind,expr.source} 结构非法");
            }
            if (!(cm.get("dependsOn") instanceof List<?> deps)) {
                throw BizException.fieldConfigInvalid("computed.dependsOn 必须为数组");
            }
            for (Object d : deps) {
                if (!(d instanceof String s) || s.isBlank()) {
                    throw BizException.fieldConfigInvalid("computed.dependsOn 元素必须为非空字符串");
                }
            }
            if (!List.of("READ_TIME", "PERSISTED").contains(cm.get("persistMode"))) {
                throw BizException.fieldConfigInvalid("computed.persistMode 取值非法");
            }
        }
    }

    /** 影响面分析（01BE §4.5）：引用表主路径 + 数据量扫描。 */
    private List<Risk> analyzeImpact(TenantInfo tenant, ModelAggregate model, List<ChangeOp> changes) {
        List<Risk> risks = new ArrayList<>();
        List<String> touchedKeys = new ArrayList<>();
        for (ChangeOp c : changes) {
            if (c.op().equals("DELETE_FIELD")) {
                touchedKeys.add(c.fieldKey());
            }
        }
        if (touchedKeys.isEmpty()) {
            return risks;
        }
        // 显式引用主路径（<10ms，01BE §4.5）
        for (Map<String, Object> ref : versions.findReferences(tenant.tenantId(), model.id(), touchedKeys)) {
            String refType = (String) ref.get("ref_type");
            String severity = switch (refType) {
                case "PAGE", "SCRIPT", "COMPUTED" -> Risk.HIGH;
                case "FLOW" -> Risk.MEDIUM;
                default -> Risk.MEDIUM;
            };
            risks.add(new Risk(refType + "_REF", asLong(ref.get("ref_id")), null, null, null, null, severity));
        }
        // DATA_VOLUME：数据键存在行数（biz_model_{id} 由 M5 建表；无表时计 0）
        long dataVolume = countDataVolume(model.id(), touchedKeys);
        if (dataVolume > 0) {
            risks.add(new Risk("DATA_VOLUME", null, null, null, null, dataVolume,
                    dataVolume >= 100_000 ? Risk.HIGH : Risk.INFO));
        }
        return risks;
    }

    private long countDataVolume(long modelId, List<String> fieldKeys) {
        // M5 建表后接入真实扫描；当前以引用表存在性降级（保持 precheck 响应形状稳定）
        return 0;
    }

    /** 三档判定（01BE §4.3）。 */
    private ConfirmMode decideConfirmMode(ModelAggregate model, List<ChangeOp> changes, List<Risk> risks) {
        boolean hasDelete = changes.stream().anyMatch(c -> c.op().equals("DELETE_FIELD"));
        boolean highRefRisk = risks.stream().anyMatch(r -> Risk.HIGH.equals(r.severity()));
        int highRefCount = (int) risks.stream().filter(r -> Risk.HIGH.equals(r.severity())
                && !r.type().equals("DATA_VOLUME")).count();
        if (hasDelete && (highRefCount >= 3 || risks.stream().anyMatch(r -> r.type().equals("API_CONSUMER")))) {
            return ConfirmMode.TYPE_MODEL_NAME;   // 删被 ≥3 页面引用或有外部调用的字段
        }
        if (hasDelete || highRefRisk) {
            return ConfirmMode.CHECKBOX;
        }
        boolean tighten = changes.stream().anyMatch(c -> c instanceof ChangeOp.ModifyField m
                && Boolean.TRUE.equals(m.patch().get("required")));
        if (tighten) {
            return ConfirmMode.CHECKBOX;
        }
        return ConfirmMode.INFO;
    }

    private void applyModify(ModelAggregate model, ChangeOp.ModifyField mod, int targetVersion) {
        Map<String, Object> p = mod.patch();
        model.modifyField(mod.fieldKey(),
                (String) p.get("label"),
                (Boolean) p.get("required"),
                (Boolean) p.get("uniqueFlag"),
                (Boolean) p.get("indexed"),
                p.get("defaultValue"),
                castList(p.get("validators")),
                castList(p.get("enumOptions")),
                castMap(p.get("relation")),
                castMap(p.get("computed")),
                p.get("sortOrder") instanceof Number n ? n.intValue() : null,
                targetVersion);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> castList(Object v) {
        return v instanceof List<?> l ? (List<Map<String, Object>>) l : null;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object v) {
        return v instanceof Map<?, ?> m ? (Map<String, Object>) m : null;
    }

    private void persistChanges(ModelAggregate model, TenantInfo tenant, List<ChangeOp> changes,
            int targetVersion) {
        if (!models.advanceVersion(model.id(), tenant.tenantId(), targetVersion - 1)) {
            throw BizException.versionConflict(-1);
        }
        model.setCurrentVersion(targetVersion); // 快照与内存聚合同步（01BE §4.2 步骤 5-6）
        OffsetDateTime now = OffsetDateTime.now();
        for (ChangeOp change : changes) {
            switch (change) {
                case ChangeOp.AddField add -> fields.insertField(model.id(), tenant.tenantId(),
                        model.findField(add.fieldKey()).orElseThrow(), targetVersion);
                case ChangeOp.ModifyField mod -> fields.updateField(model.id(), tenant.tenantId(),
                        model.findField(mod.fieldKey()).orElseThrow(), targetVersion);
                case ChangeOp.DeleteField del -> fields.markDeleted(model.id(), tenant.tenantId(),
                        del.fieldKey(), targetVersion);
                case ChangeOp.PromoteColumn pro -> fields.updateField(model.id(), tenant.tenantId(),
                        model.findField(pro.fieldKey()).orElseThrow(), targetVersion);
            }
        }
    }

    private void persistRollback(ModelAggregate model, TenantInfo tenant, List<ChangeOp> changes,
            int newVersion) {
        if (!models.advanceVersion(model.id(), tenant.tenantId(), newVersion - 1)) {
            throw BizException.versionConflict(-1);
        }
        model.setCurrentVersion(newVersion);
        for (ChangeOp change : changes) {
            switch (change) {
                case ChangeOp.AddField add -> {
                    var existing = model.findField(add.fieldKey()).orElseThrow();
                    if (fields.existsActiveInDb(model.id(), add.fieldKey())) {
                        // DB 侧为 DELETED → 复活路径（01BE §4.3：草稿态，不自动 promote）
                        fields.resurrectField(model.id(), tenant.tenantId(), existing, newVersion);
                        fields.updateField(model.id(), tenant.tenantId(), existing, newVersion);
                    } else if (existing.id() == null) {
                        fields.insertField(model.id(), tenant.tenantId(), existing, newVersion);
                    } else {
                        fields.updateField(model.id(), tenant.tenantId(), existing, newVersion);
                    }
                }
                case ChangeOp.ModifyField mod -> fields.updateField(model.id(), tenant.tenantId(),
                        model.findField(mod.fieldKey()).orElseThrow(), newVersion);
                case ChangeOp.DeleteField del -> fields.markDeleted(model.id(), tenant.tenantId(),
                        del.fieldKey(), newVersion);
                default -> throw new IllegalStateException();
            }
        }
    }

    private List<ModelAggregate.FieldDef> collectPendingPromotions(ModelAggregate model) {
        List<ModelAggregate.FieldDef> result = new ArrayList<>();
        for (var f : model.allFields()) {
            if (f.indexed() && "PENDING".equals(f.promoteStatus())) {
                result.add(f);
            }
        }
        return result;
    }

    /**
     * 计算字段引用登记（01BE §4.5：COMPUTED 引用在字段保存时由本服务自己登记）。
     * 全量重建口径：先清空该模型全部 COMPUTED 引用，再按聚合当前字段定义重建——
     * MODIFY 改 dependsOn、删除计算字段、回滚后旧引用行均不留残留（残留会让影响面误报 COMPUTED_REF）。
     * 引用真源 = 当前字段定义而非本次 changes（回滚场景 changes 只含差异，重建才完整）。
     */
    private void registerComputedReferences(TenantInfo tenant, ModelAggregate model) {
        versions.deleteAllComputedReferences(model.id());
        for (ModelAggregate.FieldDef f : model.allFields()) {
            if (!f.isActive() || f.computedConfig() == null) {
                continue;
            }
            if (f.computedConfig().get("dependsOn") instanceof List<?> deps) {
                List<String> dependsOn = new ArrayList<>();
                for (Object d : deps) {
                    if (d instanceof String s && !s.isBlank()) {
                        dependsOn.add(s);
                    }
                }
                versions.upsertComputedReferences(tenant.tenantId(), model.id(), f.fieldKey(), dependsOn);
            }
        }
    }

    /** 快照（01BE §4.2 步骤 5）：完整字段定义可整体还原（含 fieldStatus——回滚需还原删除语义）。 */
    private void snapshot(ModelAggregate model, List<Map<String, Object>> diff, long operatorId,
            Integer rollbackFrom) {
        List<Map<String, Object>> fieldSnapshots = new ArrayList<>();
        for (ModelAggregate.FieldDef f : model.allFields()) {
            fieldSnapshots.add(fieldView(f, true));
        }
        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("modelKey", model.modelKey());
        snapshot.put("name", model.name());
        snapshot.put("fields", fieldSnapshots);
        versions.insertSnapshot(new SchemaVersionRepository.VersionSnapshot(
                model.id(), model.currentVersion(), Json.write(snapshot), Json.write(diff),
                operatorId, OffsetDateTime.now(), rollbackFrom));
    }

    static Map<String, Object> fieldView(ModelAggregate.FieldDef f, boolean withStatus) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("fieldKey", f.fieldKey());
        m.put("label", f.label());
        m.put("type", f.fieldType());
        if (withStatus) {
            m.put("fieldStatus", f.fieldStatus());
        }
        m.put("required", f.required());
        m.put("uniqueFlag", f.uniqueFlag());
        m.put("indexed", f.indexed());
        m.put("promoteStatus", f.promoteStatus());
        if (f.defaultValue() != null) m.put("defaultValue", f.defaultValue());
        if (f.validators() != null) m.put("validators", f.validators());
        if (f.enumOptions() != null) m.put("enumOptions", f.enumOptions());
        if (f.relationConfig() != null) m.put("relation", f.relationConfig());
        if (f.computedConfig() != null) m.put("computed", f.computedConfig());
        m.put("sortOrder", f.sortOrder());
        m.put("schemaVersion", f.schemaVersion());
        return m;
    }

    /** 快照 → 变更集：目标快照与当前活跃集合的差异（01BE §4.4）；快照含 fieldStatus，DELETED 条目按删除语义处理。 */
    private List<ChangeOp> diffSnapshotToChanges(ModelAggregate model, Map<String, Object> snapshotFields) {
        List<ChangeOp> changes = new ArrayList<>();
        Map<String, Map<String, Object>> target = new LinkedHashMap<>();
        Object raw = snapshotFields.get("fields");
        if (raw instanceof List<?> list) {
            for (Object item : list) {
                if (item instanceof Map<?, ?> m) {
                    target.put(String.valueOf(m.get("fieldKey")), castMap(m));
                }
            }
        }
        // 目标有、当前无（或状态不同）→ 复活/新增/补删除；状态以快照记录为准（历史快照无 fieldStatus 键时视为 ACTIVE）
        for (var entry : target.entrySet()) {
            boolean targetDeleted = "DELETED".equals(entry.getValue().get("fieldStatus"));
            var current = model.findField(entry.getKey());
            if (targetDeleted) {
                // 目标版本该字段已是删除态：当前若活跃 → 补一条删除（还原删除语义）
                if (current.isPresent() && current.get().isActive()) {
                    changes.add(new ChangeOp.DeleteField(entry.getKey()));
                }
                continue;
            }
            if (current.isEmpty() || current.get().deleted()) {
                changes.add(new ChangeOp.AddField(entry.getKey(), entry.getValue()));
            } else if (!sameField(current.get(), entry.getValue())) {
                changes.add(new ChangeOp.ModifyField(entry.getKey(), diffPatch(current.get(), entry.getValue())));
            }
        }
        // 当前活跃、目标无 → 删除
        for (var f : model.activeFields()) {
            if (!target.containsKey(f.fieldKey())) {
                changes.add(new ChangeOp.DeleteField(f.fieldKey()));
            }
        }
        return changes;
    }

    private boolean sameField(ModelAggregate.FieldDef f, Map<String, Object> target) {
        Map<String, Object> view = fieldView(f, true);
        for (var e : target.entrySet()) {
            if ("fieldStatus".equals(e.getKey())) {
                continue; // 状态差异由 diffSnapshotToChanges 显式分支处理，不进 MODIFY patch
            }
            Object mine = view.get(e.getKey());
            if (!java.util.Objects.equals(normalize(mine), normalize(e.getValue()))) {
                return false;
            }
        }
        return true;
    }

    private static Object normalize(Object v) {
        if (v instanceof Double d && d == Math.floor(d)) {
            return d.longValue();
        }
        if (v instanceof Float fl && fl == Math.floor(fl)) {
            return (long) (double) fl;
        }
        return v;
    }

    private Map<String, Object> diffPatch(ModelAggregate.FieldDef current, Map<String, Object> target) {
        Map<String, Object> view = fieldView(current, true);
        Map<String, Object> patch = new LinkedHashMap<>();
        for (var e : target.entrySet()) {
            if ("fieldStatus".equals(e.getKey())) {
                continue; // 状态迁移走 ADD（复活）/DELETE 分支，不进 MODIFY patch
            }
            if (!java.util.Objects.equals(normalize(view.get(e.getKey())), normalize(e.getValue()))) {
                patch.put(e.getKey(), e.getValue());
            }
        }
        return patch;
    }

    private List<Risk> rollbackRisks(TenantInfo tenant, ModelAggregate model, String snapshotJson) {
        List<Risk> risks = new ArrayList<>();
        List<String> deletedKeys = new ArrayList<>();
        Map<String, Object> snapshot = Json.readMap(snapshotJson);
        Object raw = snapshot.get("fields");
        Map<String, Object> target = new LinkedHashMap<>();
        if (raw instanceof List<?> list) {
            for (Object item : list) {
                if (item instanceof Map<?, ?> m) {
                    target.put(String.valueOf(m.get("fieldKey")), castMap(m));
                }
            }
        }
        for (var f : model.activeFields()) {
            if (!target.containsKey(f.fieldKey())) {
                deletedKeys.add(f.fieldKey());
            }
        }
        for (Map<String, Object> ref : versions.findReferences(tenant.tenantId(), model.id(), deletedKeys)) {
            risks.add(new Risk((String) ref.get("ref_type") + "_REF", asLong(ref.get("ref_id")), null,
                    null, null, null, Risk.HIGH));
        }
        return risks;
    }

    private static Long asLong(Object v) {
        return v instanceof Number n ? n.longValue() : null;
    }

    private static String newToken() {
        byte[] bytes = new byte[24];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /** changes 摘要（01BE §4.2：token 绑定 changes 摘要 hash + baseVersion）。 */
    static String bindingHash(List<ChangeOp> changes) {
        StringBuilder sb = new StringBuilder();
        for (ChangeOp c : changes) {
            sb.append(c.op()).append('|').append(c.fieldKey()).append('|');
            if (c instanceof ChangeOp.AddField a) {
                sb.append(Json.write(a.field())).append('|');
            } else if (c instanceof ChangeOp.ModifyField m) {
                sb.append(Json.write(m.patch())).append('|');
            }
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(sb.toString().getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
