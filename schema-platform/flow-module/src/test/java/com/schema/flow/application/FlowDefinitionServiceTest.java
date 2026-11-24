package com.schema.flow.application;

import com.schema.flow.domain.FlowDtos.FlowEdge;
import com.schema.flow.domain.FlowDtos.FlowNode;
import com.schema.flow.domain.FlowDtos.FlowSchema;
import com.schema.flow.domain.FlowDtos.UserApprover;
import com.schema.flow.domain.FlowErrors;
import com.schema.flow.domain.repository.FlowDefinitionRepository;
import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import com.schema.platform.common.web.BizException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 定义服务单测（spec 021 T4）。
 *
 * 用内存仓储验证：状态机、乐观锁、发布校验链、错误码。
 * 真实 PG 行为（唯一约束/JSONB）由后续 IT 覆盖——此处不重复造 DB 语义。
 */
class FlowDefinitionServiceTest {

    private static final long TENANT = 51L;

    private InMemoryRepo repo;
    private StubGateway gateway;
    private FlowDefinitionService service;

    @BeforeEach
    void setUp() {
        repo = new InMemoryRepo();
        gateway = new StubGateway(true);
        service = new FlowDefinitionService(repo, gateway);
        TenantContext.with(new TenantInfo(TENANT, 1L, 88L), () -> null);
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    // ---------- fixtures ----------

    private static FlowSchema linear() {
        return new FlowSchema("leave", "请假流程", 1, 1,
                List.of(new FlowNode("s1", "START", "开始", null, null),
                        new FlowNode("a1", "APPROVAL", "主管审批",
                                new UserApprover(List.of("7")), null),
                        new FlowNode("e1", "END", "结束", null, null)),
                List.of(new FlowEdge("f1", "s1", "a1", null),
                        new FlowEdge("f2", "a1", "e1", null)));
    }

    private static FlowSchema withUnsupportedNode() {
        return new FlowSchema("branchy", "带分支", 1, 1,
                List.of(new FlowNode("s1", "START", "开始", null, null),
                        new FlowNode("c1", "CONDITION_BRANCH", "金额判断", null, null),
                        new FlowNode("e1", "END", "结束", null, null)),
                List.of(new FlowEdge("f1", "s1", "c1", null),
                        new FlowEdge("f2", "c1", "e1", null)));
    }

    // ---------- create ----------

    @Test
    void createsDraftDefinition() {
        Map<String, Object> out = service.create(1L, "请假流程", linear());
        long id = Long.parseLong(String.valueOf(out.get("id")));

        Map<String, Object> row = repo.store.get(id);
        assertNotNull(row);
        assertEquals("DRAFT", row.get("status"));
        assertEquals(1, row.get("version"));
        assertEquals("leave", row.get("flow_key"));
    }

    @Test
    void rejectsDuplicateFlowKey() {
        service.create(1L, "请假流程", linear());

        BizException e = assertThrows(BizException.class,
                () -> service.create(1L, "另一个", linear()));
        assertEquals(FlowErrors.VERSION_CONFLICT, e.code());
    }

    @Test
    void rejectsInvalidSchemaOnCreate() {
        FlowSchema broken = new FlowSchema("k", "n", 1, 1,
                List.of(new FlowNode("s1", "START", null, null, null)), // 缺 END
                List.of());
        BizException e = assertThrows(BizException.class, () -> service.create(1L, "坏流程", broken));
        assertEquals(FlowErrors.SCHEMA_INVALID, e.code());
    }

    // ---------- saveDraft ----------

    @Test
    void savesDraftAndBumpsVersion() {
        long id = idOf(service.create(1L, "请假流程", linear()));

        Map<String, Object> out = service.saveDraft(id, linear(), 1);
        assertEquals(2, out.get("version"));
        assertEquals(2, repo.store.get(id).get("version"));
    }

    @Test
    void rejectsStaleBaseVersion() {
        long id = idOf(service.create(1L, "请假流程", linear()));
        service.saveDraft(id, linear(), 1); // → version 2

        BizException e = assertThrows(BizException.class,
                () -> service.saveDraft(id, linear(), 1)); // 用旧 baseVersion
        assertEquals(FlowErrors.VERSION_CONFLICT, e.code());
        assertEquals(2, e.details().get("serverVersion"), "必须回传 serverVersion 供前端刷新");
    }

    @Test
    void requiresBaseVersion() {
        long id = idOf(service.create(1L, "请假流程", linear()));
        BizException e = assertThrows(BizException.class,
                () -> service.saveDraft(id, linear(), null));
        assertEquals(FlowErrors.VERSION_CONFLICT, e.code());
    }

    // ---------- publish ----------

    @Test
    void publishesWithDeployment() {
        long id = idOf(service.create(1L, "请假流程", linear()));

        Map<String, Object> out = service.publish(id);
        assertEquals(2, out.get("version"));
        assertEquals("PUBLISHED", repo.store.get(id).get("status"));
        assertEquals("dep-1", repo.store.get(id).get("deployment_id"));
        assertTrue(gateway.deployedXml.contains("<userTask id=\"a1\""),
                "发布必须真的把 BPMN 交给引擎");
    }

    @Test
    void publishRejectsUnsupportedNodeAndProducesNoDeployment() {
        long id = idOf(service.create(1L, "带分支", withUnsupportedNode()));

        BizException e = assertThrows(BizException.class, () -> service.publish(id));
        assertEquals(FlowErrors.NODE_TYPE_NOT_SUPPORTED, e.code());
        assertEquals(0, gateway.deployCount, "校验失败不得产生 deployment（A7）");
        assertEquals("DRAFT", repo.store.get(id).get("status"), "失败的发布不改状态");
    }

    @Test
    void publishFailsLoudlyWhenEngineDisabled() {
        gateway = new StubGateway(false);
        service = new FlowDefinitionService(repo, gateway);
        long id = idOf(service.create(1L, "请假流程", linear()));

        BizException e = assertThrows(BizException.class, () -> service.publish(id));
        assertEquals(FlowErrors.FLOW_DEF_NOT_PUBLISHED, e.code());
        assertEquals("DRAFT", repo.store.get(id).get("status"),
                "不能用「已发布」掩盖未部署（假状态最难排查）");
    }

    // ---------- detail ----------

    @Test
    void detailReturnsSchemaAsObject() {
        long id = idOf(service.create(1L, "请假流程", linear()));

        Map<String, Object> detail = service.detail(id);
        assertEquals("leave", detail.get("flowKey"));
        assertTrue(detail.get("flowSchema") instanceof Map,
                "flowSchema 必须返回对象（前端直接消费，不解析字符串）");
    }

    @Test
    void detailOfMissingDefinitionIs404Code() {
        BizException e = assertThrows(BizException.class, () -> service.detail(9999));
        assertEquals(FlowErrors.FLOW_DEF_NOT_FOUND, e.code());
    }

    @Test
    void transferIsNotImplemented() {
        BizException e = assertThrows(BizException.class, () -> service.notImplemented("转办"));
        assertEquals(FlowErrors.NOT_IMPLEMENTED, e.code());
    }

    // ---------- helpers ----------

    private static long idOf(Map<String, Object> out) {
        return Long.parseLong(String.valueOf(out.get("id")));
    }

    /** 内存仓储（只实现服务用到的行为）。 */
    private static class InMemoryRepo implements FlowDefinitionRepository {
        final Map<Long, Map<String, Object>> store = new LinkedHashMap<>();
        private final AtomicLong seq = new AtomicLong(0);

        @Override
        public long insert(long tenantId, long appId, String flowKey, String name, String status,
                String flowSchemaJson, long createdBy) {
            long id = seq.incrementAndGet();
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", id);
            row.put("tenant_id", tenantId);
            row.put("app_id", appId);
            row.put("flow_key", flowKey);
            row.put("name", name);
            row.put("status", status);
            row.put("version", 1);
            row.put("flow_schema", flowSchemaJson);
            row.put("created_by", createdBy);
            store.put(id, row);
            return id;
        }

        @Override
        public Optional<Map<String, Object>> findById(long tenantId, long id) {
            Map<String, Object> row = store.get(id);
            if (row == null || ((Number) row.get("tenant_id")).longValue() != tenantId) {
                return Optional.empty();
            }
            return Optional.of(row);
        }

        @Override
        public Optional<Map<String, Object>> findByKey(long tenantId, long appId, String flowKey) {
            return store.values().stream()
                    .filter(r -> ((Number) r.get("tenant_id")).longValue() == tenantId)
                    .filter(r -> ((Number) r.get("app_id")).longValue() == appId)
                    .filter(r -> flowKey.equals(r.get("flow_key")))
                    .findFirst();
        }

        @Override
        public List<Map<String, Object>> listByApp(long tenantId, long appId) {
            List<Map<String, Object>> out = new ArrayList<>();
            for (Map<String, Object> r : store.values()) {
                if (((Number) r.get("tenant_id")).longValue() == tenantId
                        && ((Number) r.get("app_id")).longValue() == appId) {
                    out.add(r);
                }
            }
            return out;
        }

        @Override
        public int updateDraft(long tenantId, long id, int baseVersion, String flowSchemaJson) {
            Map<String, Object> row = store.get(id);
            if (row == null || ((Number) row.get("version")).intValue() != baseVersion) {
                return 0;
            }
            row.put("flow_schema", flowSchemaJson);
            row.put("version", baseVersion + 1);
            return 1;
        }

        @Override
        public int markPublished(long tenantId, long id, int expectedVersion, int nextVersion,
                String flowSchemaJson, String deploymentId) {
            Map<String, Object> row = store.get(id);
            if (row == null || ((Number) row.get("version")).intValue() != expectedVersion) {
                return 0;
            }
            row.put("status", "PUBLISHED");
            row.put("version", nextVersion);
            row.put("flow_schema", flowSchemaJson);
            row.put("deployment_id", deploymentId);
            return 1;
        }
    }

    /** 部署网关桩：记录是否真的被调用。 */
    private static class StubGateway implements FlowDeploymentGateway {
        private final boolean available;
        int deployCount = 0;
        String deployedXml = "";

        StubGateway(boolean available) {
            this.available = available;
        }

        @Override
        public boolean isAvailable() {
            return available;
        }

        @Override
        public String deploy(String processKey, String resourceName, String bpmnXml) {
            if (!available) {
                throw new BizException(FlowErrors.FLOW_DEF_NOT_PUBLISHED, "引擎未启用");
            }
            deployCount++;
            deployedXml = bpmnXml;
            return "dep-" + deployCount;
        }
    }
}