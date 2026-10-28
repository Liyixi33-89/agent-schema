# 低代码平台后端技术方案（Java）

> 版本：v0.2 | 日期：2026-10-26 | 角色：高级后端工程师视角
> 配套文档：《PRD-低代码平台产品规划.md》（v0.2 决策已定稿）《技术方案-前端(React).md》
>
> v0.2 变更（对齐 PRD §6 决策）：
> - §3 数据模型：删除改为**纯逻辑删除**，明确「不做数据迁移」
> - §3.2 版本：迁移脚本 → **版本快照 + 回滚**，去掉数据迁移职责
> - §3.4 新增：**编译服务**（自定义代码设计时编译，支撑双轨渲染）
> - §6 新增：**L3 沙箱执行服务**、**L4 连接器服务**
> - §7 新增：**计量与出账服务（Metering）**
> - §10 私有化：License 体系**移出一期**，改为架构预留清单

## 1. 技术选型总览

| 领域 | 选型 | 说明 |
|---|---|---|
| 语言/框架 | Java 21 + Spring Boot 3.x | 虚拟线程正式可用（JDK21 已转 final）；**预览特性（含 ScopedValue）不进主干**，租户上下文存储接口化（详 03BE §2.1） |
| 微服务框架 | Spring Cloud Alibaba（或自建网关+注册中心） | 服务拆分见 §2 |
| API 网关 | Spring Cloud Gateway | 鉴权、租户路由、限流统一入口 |
| 元数据存储 | PostgreSQL（主库，JSONB 存 Schema 定义） | JSONB 对半结构化的 Schema 定义天然友好，支持 GIN 索引查询 |
| 业务数据存储 | 动态表方案：PostgreSQL（宽表/多租户 Schema 隔离） | 见 §3 数据模型设计详述，这是整个平台最核心的技术决策 |
| 缓存 | Redis（Schema 元数据缓存、分布式锁、会话） | |
| 消息队列 | **Kafka（决策定版，ADR-001）** | 流程引擎异步任务、Schema变更事件广播、Webhook投递。原文"RocketMQ / Kafka 二选一"现定版 Kafka：①详细设计 01/02/09/12 已全部按 Kafka topic 落地（ddl.promote / metering.raw / notify.dispatch），回头改 RocketMQ 成本远大于收益；②计量采集需高吞吐分区顺序写入，Kafka 按 tenantId 分区保证租户内顺序（文档 09）与需求吻合；③私有化交付 MinIO+Kafka+Redis 全开源栈一致。切换 RocketMQ 仅在「客户指定中间件」的私有化场景触发，届时走 §11 接口化适配层，不改业务 topic 语义 |
| 搜索 | **Elasticsearch 暂不启动（ADR-002）** | 原"可选，二期"。①全文检索一期由 PostgreSQL GIN 索引承接（文档 02 §2.1）；②复杂报表由数据引擎聚合接口承接（文档 02 §3.6）；③显式标注：待首个全文检索需求确认后再启动设计资源——避免持有"既未落地又未否决"的悬空选型 |
| 工作流引擎 | Flowable（内嵌 BPMN 引擎） | 不重复造轮子，审批流/业务流程基于 BPMN 2.0 标准封装低代码配置层 |
| 规则/表达式引擎 | Aviator 或 SpEL（沙箱化） | 条件分支、计算字段、数据权限规则表达式求值 |
| 对象存储 | MinIO / 阿里云OSS（S3协议） | 文件上传 |
| 认证授权 | Spring Security + OAuth2/JWT + Sa-Token(可选) | 多租户 + RBAC + 数据权限 |
| ORM/动态SQL | MyBatis-Plus + 自研动态 SQL 生成层 | 标准 JPA/Hibernate 难以应对"运行时动态建表+动态查询"，需要自建元数据驱动的 SQL 构建器 |
| API 文档 | SpringDoc OpenAPI | 自动生成的 CRUD API 文档需要动态刷新 |
| 容器/部署 | Docker（K8s/Helm 留到私有化交付时再做） | 一期纯 SaaS，架构保留容器化能力 |
| 计量存储 | ClickHouse（明细，量大）/ PostgreSQL 分区表（小规模） | 见 §10 |
| 构建 Worker | Node 容器（esbuild/vite） | 自定义代码编译，见 §3.4 |
| 多租户框架 | 自研 TenantContext + MyBatis 拦截器 | 见 §4 |
| 监控 | SkyWalking/Prometheus + Grafana + ELK | |
| 构建 | Maven/Gradle Multi-Module | |

---

## 2. 微服务拆分（领域边界）

```
schema-backend/
├── gateway-service          # API 网关：鉴权、租户解析、限流、路由
├── metadata-service         # 核心：Schema 元数据管理（建模、版本、影响面、回滚）★核心服务
├── data-engine-service      # 核心：动态数据引擎（基于元数据的通用 CRUD/查询执行）★核心服务
├── page-service             # 页面/表单 Schema 的 CRUD 与版本管理
├── flow-service             # 流程/审批引擎（封装 Flowable）
├── permission-service       # RBAC + 数据权限 + 组织架构
├── tenant-service           # 租户生命周期、应用生命周期管理          → 详细设计《详细技术文档 13》
├── integration-service      # 第三方集成（企业微信/飞书/短信/邮件/Webhook）
├── file-service             # 文件上传/存储代理                      → 详细设计《详细技术文档 11》
├── notification-service     # 消息通知（站内信/邮件/短信聚合）        → 详细设计《详细技术文档 12》
├── open-api-service         # 对外开放平台（API Key、文档、限流配额）
├── build-service            # 自定义代码编译服务（Node Worker 池，↔ §3.4）
├── connector-service        # L4 外部服务连接器 + 密钥托管（↔ §9.2）
├── script-executor          # L3 受管脚本沙箱执行器（独立部署，↔ §9.1）
├── metering-service         # 计量采集/聚合/配额/出账（↔ §10）
├── ai-gateway               # AI 辅助建模网关（P3 预留，↔ §12）      → 骨架设计《详细技术文档 14》
└── common/
    ├── schema-protocol-java # Schema 协议 Java Bean/DTO（与前端 TS 协议对应的 Java 镜像）
    ├── common-security      # 多租户上下文、JWT 工具
    ├── common-web           # 统一返回体、异常处理
    └── common-datasource    # 动态数据源/动态 SQL 工具
```

> **单体 vs 微服务权衡**：MVP 阶段建议先用"模块化单体"（Spring Boot Modulith，上述包结构作为 Maven 模块而非独立部署的微服务），验证业务模型跑通后再按团队规模/流量拆分独立服务，避免过早引入分布式复杂度（分布式事务、服务发现开销）。`metadata-service` 和 `data-engine-service` 是第一批值得独立拆分的，因为它们是性能/扩展性瓶颈点。

---

## 3. 核心难题：动态数据模型存储方案

这是低代码平台后端架构的**最关键决策**，需要在"灵活性""性能""运维复杂度"间权衡。三种主流方案对比：

| 方案 | 说明 | 优点 | 缺点 |
|---|---|---|---|
| **A. 真实建表（DDL）** | 用户建模时后端执行 `CREATE TABLE`/`ALTER TABLE` | 查询性能好、可用标准 SQL/索引/关系约束 | DDL 频繁变更有锁表风险；多租户下表数量爆炸；迁移/回滚复杂 |
| **B. EAV（实体-属性-值）** | 固定几张元表（entity/attribute/value）存所有业务数据 | 建模零成本、无需 DDL | 查询需要大量 JOIN，性能差，复杂查询(排序/聚合)很痛苦 |
| **C. JSONB 宽表混合方案（推荐）** | 每个模型对应一张物理表，固定几个系统列(id/tenant_id/created_at等) + 一个 `data JSONB` 列存所有业务字段，**对高频查询/排序字段做"提升列"（promoted column）+ 表达式索引** | 兼顾灵活性与性能；PostgreSQL JSONB + GIN 索引查询效率可接受；避免频繁 DDL | 复杂多表 JOIN 仍需在应用层处理或用 JSONB 的关联ID+二次查询 |

**最终建议：方案 C（JSONB 混合方案）**，具体设计：

```sql
-- 每个"模型"对应一张物理表（建模时自动创建，而非每条数据一行EAV）
CREATE TABLE biz_model_<model_id> (
  id              BIGINT PRIMARY KEY,
  tenant_id       BIGINT NOT NULL,
  data            JSONB NOT NULL,      -- 存所有未提升的业务字段（含已删除字段的历史值）
  schema_version  INT NOT NULL,        -- 该行写入时的 Schema 版本（供读时兼容判断）
  created_by      BIGINT,
  created_at      TIMESTAMP,
  updated_at      TIMESTAMP,
  deleted_at      TIMESTAMP,           -- 记录级逻辑删除
  -- 高频查询/排序字段：建模时标记为"索引字段"后，自动生成提升列
  status          VARCHAR(50) GENERATED ALWAYS AS (data->>'status') STORED,
  amount          NUMERIC GENERATED ALWAYS AS ((data->>'amount')::numeric) STORED
);
CREATE INDEX idx_<model_id>_tenant ON biz_model_<model_id>(tenant_id);
CREATE INDEX idx_<model_id>_status ON biz_model_<model_id>(status);
CREATE INDEX idx_<model_id>_data_gin ON biz_model_<model_id> USING GIN(data);
```

**与 PRD §6.1 决策对齐的存储规则（重要）：**

| 变更类型 | 存储层行为 |
|---|---|
| 新增字段 | 仅写元数据，**无 DDL**。存量行 `data` 中该键不存在 → 读取时按 Schema 默认值/null 填充 |
| 修改字段类型 | **不可修改**（field_type 创建后冻结）。需要换类型 = 新建字段 + 用户用数据体检工具人工迁移（PRD 01 §2.9；决策口径详见协议评审稿）。写入校验按字段类型执行；读取兼容仅需处理新增字段缺键与版本差异两类情形 |
| 删除字段 | **元数据置 `field_status='DELETED'` + `deleted_at`，物理列（提升列）与 `data` 中的键永不移除**。API 默认不返回该字段（`includeDeletedFields=true` 白名单，仅管理员） |
| 删除模型 | 元数据置删除标识，物理表 `biz_model_*` **保留**（命名改为 `biz_model_<id>_archived` 或加 `archived` 标记，视运维策略），不 DROP |
| 提升列（索引字段） | 仅有该操作触发 DDL：`ALTER TABLE ADD COLUMN ... GENERATED ALWAYS AS ... STORED` + `CREATE INDEX`，异步执行、走后台任务 + 影响面评估 |
| 已删除的提升列 | **不 DROP COLUMN**（PostgreSQL DROP 会重写表且不可逆），仅从元数据移除引用并停止使用 |

> ⚠️ 为什么不 DROP：PostgreSQL 的 `DROP COLUMN` 在旧版本会重写全表（大表锁死数小时），且操作不可逆。保留冗余列的成本远低于误删数据的代价。**这也意味着"压缩历史列"必须做成显式的、需要审批的运维工具，而不是产品里的一个按钮。**

- **关联字段（relation）**：存对方记录 ID（JSONB 内或提升列），查询时应用层二次批量查询+内存拼装（DataLoader 模式，避免 N+1）。
- **多租户隔离**：表级不拆分（避免表数量爆炸），统一 `tenant_id` 行级隔离，查询层强制注入租户过滤（见 §4）。大客户可选"独立 Schema"。
- **表数量控制**：单租户模型数上限（如 200），超过走"共享表 + model_id 分区"模式（`biz_data_unified` 表 + `model_id` 列 + 按 model_id 的 partial index），避免物理表爆炸。

### 3.1 动态查询引擎（data-engine-service 核心）

```java
public interface DynamicQueryEngine {
    PageResult<Map<String, Object>> query(QueryRequest request);
    Map<String, Object> getById(String modelId, Long id);
    Long create(String modelId, Map<String, Object> data);
    void update(String modelId, Long id, Map<String, Object> data);
    void delete(String modelId, Long id);   // 记录级逻辑删除：写 deleted_at
}
```

- `QueryRequest` 包含：modelId、过滤条件树（AND/OR 嵌套）、排序、分页、字段投影、关联字段级联深度、`includeDeletedFields`（仅管理员）。
- 内部基于 **MyBatis 动态 SQL + 元数据映射**，将逻辑字段名翻译为"提升列 or `data->>'field'` 表达式"，对调用方屏蔽物理存储细节。
- **已删除字段强制过滤**：SQL 构建器从元数据加载时即排除 `field_status='DELETED'` 的字段，无论调用方传什么参数都不返回（白名单开关例外且记审计）。这是**唯一可靠的过滤点**——不能依赖前端隐藏，否则直接调 API 即可绕过。
- **SQL 注入防护**：字段名/操作符走元数据白名单校验（字段存在 + 类型匹配），值一律走 PreparedStatement 占位符，绝不字符串拼接。
- **读时兼容（对应 PRD「不做迁移」策略）**：读取时若 `row.schema_version < currentVersion`，按版本链做字段级宽松转换（如新增字段补默认值、类型不匹配降级为原始值+标记 `_invalid`），**只读转换，不回写数据库**。
- 查询性能：常用过滤字段引导设为"索引字段"；列表查询默认 `LIMIT` 硬上限（如 200）防深分页拖垮库。

### 3.2 Schema 版本与回滚（不做数据迁移）

```java
class ModelSchemaVersion {
    Long modelId;
    Integer version;
    JsonNode schemaSnapshot;    // 该版本的完整字段定义快照（可完整还原）
    JsonNode diff;              // 相对上一版本的变更（ADD/MODIFY/DELETE_FIELD/PROMOTE_COLUMN...）
    Long operatorId;
    Instant createdAt;
    String rollbackFrom;        // 若非空，表示本版本由回滚产生
}
```

- 每次保存生成一条版本记录 + diff，支撑影响面分析、审计、回滚。
- **不生成任何数据迁移脚本**（PRD §6.1 决策）：因为存量数据永远保持原样，且删除是逻辑的，所以「迁移」这一整块职责被移除——**这是本次决策带给后端最大的简化**。
- **回滚 = 恢复元数据快照**：把字段定义切换回历史版本（含把 `DELETED` 状态改回 `ACTIVE`）。因为数据从未删除，回滚后数据自动可用。回滚需二次确认 + 记录审计，且回滚不撤销期间产生的新数据（可能含不符合旧 Schema 的字段值——按读时兼容处理）。
- 需要保留的能力：**数据兼容性体检工具**（只读扫描不兼容存量数据），配合「数据修复」工具页由用户手动决定是否批量修正，**平台不自动改数据**。

### 3.3 影响面分析（保存前强制，PRD §3.1.2）

变更某字段前，后端聚合四类依赖返回给前端：

| 依赖 | 实现 | 注意事项 |
|---|---|---|
| 页面/表单引用 | 扫描 `page_schema` 的 JSON（`props` 与 `dataBinding` 中出现的字段 key） | 用 PostgreSQL JSONB 查询或 ES 索引；页面多时需异步化（先返回"分析中"，完成后推送） |
| 流程/自动化引用 | 扫描流程 Schema 中表达式 AST 的字段引用 | **解析表达式后取引用，而非字符串匹配**（避免 `amount` 误匹配 `amount_total`） |
| 开放 API 消费方 | 聚合近 30/90 天调用日志中出现的该字段 | 依赖按字段维度埋点；成本高时退化为"按接口 + 响应体 schema 比对" |
| 存量数据量 | `SELECT count(*) FROM t WHERE data ? 'field'` | 大表需 `EXPLAIN` 确认走 GIN 索引；超阈值（如 100 万）改为采样估算 |

**性能与一致性的权衡（关键工程决策）：**

依赖关系建议**维护成显式引用表** `field_reference(model_id, field_key, ref_type, ref_id)`，在页面/流程保存时写入，而非每次变更全库扫描——否则模型多了以后影响面分析会变成慢接口。

- 显式引用表：快，但**可能漏**（历史数据、脚本里的动态字符串引用）
- 全库扫描：准，但慢且成本高

**建议做法**：主路径用显式引用表（同步返回），每次变更额外异步触发一次全扫描兜底，对比差异并告警（发现漏登记则回补）。**既不错杀体验，也不漏报风险。**

### 3.4 代码编译服务（支撑双轨渲染，PRD §6.2）

自定义代码需要"设计时编译、运行时加载产物"，后端提供编译能力：

```java
public interface CodeBuildService {
    BuildResult build(BuildRequest req);
}

class BuildRequest {
    String appId; Long pageId;
    String sourceCode;        // 客户编写的 TS/JSX
    String runtimeVersion;    // 平台运行时 SDK 版本，决定 tsconfig/lib
}

class BuildResult {
    String artifactUrl;       // 产物地址，命名 artifact-{contentHash}.js
    String contentHash;
    List<CompileError> errors;   // 编译失败时返回行号与原因
}
```

- **实现方式**：独立构建 Worker（Node 容器内跑 esbuild/vite），后端只负责调度、产物存储、版本记录。**不要在 Java 进程里跑 JS 工具链。**
- **安全**：构建过程**不执行**客户代码（只编译）；依赖白名单（仅平台 SDK + 白名单库，禁止任意 npm 包）。
- **并发与配额**：单租户构建队列隔离 + 并发上限，防止高频保存打爆构建集群。
- **产物不可变**：URL 带 contentHash，CDN 长缓存；页面 Schema 记录 `artifactHash` 便于审计追溯。
- **失败不覆盖**：编译失败时不更新 `artifactHash`，前端继续跑上一版产物；错误详情返回设计器展示。

---

## 4. 多租户架构

**隔离级别**：行级隔离（默认，SaaS 标准租户）+ Schema级隔离（大客户可选）+ 独立实例（私有化部署）。

```java
// 租户上下文存储接口化（M0 定版决策）：JDK21 的 ScopedValue 仍为预览特性，不进主干
public final class TenantContext {
    private static final TenantContextHolder HOLDER = TenantContextHolder.threadLocal();
    // Holder 接口三方法 get/with/clear；JDK ScopedValue 转正式后切换实现，业务代码零改动
}

// MyBatis 拦截器自动给 SQL 注入租户过滤
@Intercepts({@Signature(type = Executor.class, method = "query", ...)})
public class TenantInterceptor implements Interceptor {
    // 自动在 WHERE 子句追加 tenant_id = #{currentTenantId}
    // 对标记为 @TenantIgnore 的查询跳过（如平台级管理后台）
}
```

- 网关层根据 域名/Header/JWT claim 解析租户 ID，透传到下游所有服务（通过 RPC 上下文/Header 传递，避免显式参数污染每个接口签名）。
- **强制性测试要求**：每个涉及数据查询的 Service 必须有"跨租户越权访问"的单元测试用例（故意传错租户上下文验证会被拦截），作为上线前 checklist 硬性要求。

---

## 5. 自动生成 API 规范

基于元数据自动暴露的 CRUD API，需要统一协议（供前端 `request-sdk` 对接）：

```
GET    /api/data/{modelId}              # 列表查询（支持 ?filter=...&sort=...&page=&size=）
GET    /api/data/{modelId}/{id}         # 详情
POST   /api/data/{modelId}              # 创建
PUT    /api/data/{modelId}/{id}         # 更新
DELETE /api/data/{modelId}/{id}         # 删除（逻辑删除）
POST   /api/data/{modelId}/batch        # 批量操作
```

- 过滤条件采用统一 JSON 结构（类似 MongoDB 查询语法或自定义 `{field, op, value}` 树），而不是零散 query 参数，便于复杂条件组合与前端表单生成。
- 响应体统一分页结构 `{list, total, page, size}`，统一错误码体系（业务错误码 + HTTP 状态码分层）。
- 自动根据 Schema 的字段权限（哪些角色可见/可编辑该字段）在响应体做字段级过滤——这是数据权限体系中容易遗漏的一环（不只是行级权限，还有列级/字段级）。
- OpenAPI 文档需要**动态生成**（标准 SpringDoc 基于注解是静态的，这里需要在运行时根据元数据反射生成 OpenAPI JSON，供开放平台和前端类型生成使用）。

---

## 6. 流程引擎设计（基于 Flowable）

- 低代码"可视化流程设计器"产出的 Schema（节点+连线 JSON）需要一个 **Transpiler 层**，将其编译为标准 BPMN 2.0 XML，再交给 Flowable 执行，而不是自己重新实现流程引擎（避免重复造轮子，审批流的会签/并行网关/超时升级等标准能力直接复用 BPMN 规范）。
- 动态审批人解析：Flowable 的 `TaskListener` 中回调 `permission-service` 按规则表达式（部门/角色/字段值计算）实时解析审批人，而非在建模时写死。
- 流程与数据的绑定：流程实例关联 `(modelId, recordId)`，流程中的"动作节点"（调API/写数据/发通知）通过 `data-engine-service` 的内部 RPC 接口执行，而非直接操作数据库（保持权限校验一致性）。
- 异步化：所有流程动作节点执行需要幂等 + 失败重试（通过 MQ 消费 + 死信队列处理人工介入的异常流程）。

---

## 7. 安全设计要点

| 风险点 | 方案 |
|---|---|
| 动态 SQL 注入 | 字段名/操作符白名单校验（基于元数据），值一律 PreparedStatement 占位符，绝不字符串拼接 |
| L3 脚本任意代码执行 | 独立沙箱执行器（§9.1），绝不在主应用进程 `eval` |
| 越权访问（水平/垂直） | 行级数据权限统一在 `data-engine-service` 的 SQL 构建层强制注入，不依赖上层业务各自实现 |
| 租户数据泄露 | §4 拦截器兜底 + 代码评审 checklist + 自动化越权测试 |
| 已删除字段数据泄露 | API 层强制过滤 + `includeDeletedFields` 仅管理员 + 每次调用记审计（§3.1） |
| 批量导出敏感数据 | 导出接口单独限流 + 水印/脱敏规则 + 审计日志 |
| API Key/开放平台滥用 | 网关限流配额 + Key 粒度访问范围控制 |
| Schema 误删数据 | 物理不删 + 影响面告知（§3.3）+ 版本回滚（§3.2） |
| 计费数据被伪造 | 埋点上报签名 + 服务端二次去重聚合（§10.1） |
| 自定义代码构建环节 | 构建过程不执行客户代码，依赖白名单（§3.4） |

---

## 8. 性能与可扩展性

- **元数据缓存**：Schema 定义走 Redis + MQ 广播失效（变更后各节点清缓存），注意失效延迟窗口内的一致性（可接受短暂脏读，但**字段删除必须强一致**——建议删除操作走"先广播失效→确认所有节点已刷→再提交元数据"的两阶段，或用版本号单调递增让节点自行发现过期）。
- **大表性能**：JSONB GIN 索引 + 提升列组合索引；千万级模型引导归档或分区表。
- **连接池**：HikariCP 调优，避免连接数随租户数线性增长；大客户独立库时按需路由。
- **异步化**：提升列 DDL、批量导入导出、影响面全扫描、数据体检，全部走任务队列 + 状态轮询。
- **水平扩展**：`data-engine-service` 无状态化，支持按租户分片路由。
- **深分页**：列表查询硬上限（size ≤ 200），Cursor/Keyset 分页替代 offset 深翻页。

---

## 9. 逃生舱后端实现

### 9.1 L3 受管脚本执行服务（Phase 3，企业版默认关闭）

**部署形态**：独立 `script-executor` 服务（K8s 独立 Deployment，与主集群网络策略隔离），主应用只通过内部 RPC 调用。

```java
public interface ScriptExecutor {
    ExecResult execute(ExecRequest req);
}

class ExecRequest {
    String scriptId; String scriptVersion;
    String entry;                 // 入口函数名
    Map<String, Object> input;    // 入参（流程节点/触发器上下文）
    ExecContext ctx;              // 租户/用户/权限上下文（数据访问继承此权限）
    Duration timeout = Duration.ofSeconds(5);
    int memoryLimitMb = 256;
}
```

**六道闸门的技术落地：**

| 闸门 | 实现 |
|---|---|
| ① 进程隔离 | GraalVM Polyglot 受限 Context（禁 `allowHostAccess`、禁 `allowIO`、禁 `allowCreateProcess`），或独立 Pod + gVisor；**绝不 Java `eval`/Nashorn** |
| ② 资源上限 | 单次执行 wall-clock 硬超时（Future.cancel + 线程中断）、内存上限、CPU 时间上限；出网白名单（默认全禁，内网 CIDR 黑名单兜底） |
| ③ 数据访问 | 只暴露 `dataEngine` 内部 client，透传 `ExecContext`（租户+用户+角色），**SQL 构建层会再校验一次数据权限**——不能信任脚本层 |
| ④ 可观测 | 每次执行落 `script_exec_log`（scriptId/version/traceId/耗时/状态/错误栈），客户端可查；接入 SkyWalking |
| ⑤ 版本与灰度 | 脚本表带 version + status（DRAFT/PUBLISHED/CANARY）；灰度按 `appId` 白名单或流量百分比路由到指定版本 |
| ⑥ 配额与计费 | Redis 令牌桶做单租户并发/QPS 上限；执行次数投递计量事件（§10） |

**关键补充**：脚本 `input` 与 `ctx` 必须**深拷贝 + 序列化边界**（JSON），不能让脚本拿到 Java 对象引用（否则可通过反射逃逸）。这是 GraalVM 沙箱最容易踩的坑。

### 9.2 L4 外部服务连接器（Phase 2，优先做）

平台不托管客户代码，只做"可靠的出站 HTTP 代理 + 密钥保险箱"。

```java
class ConnectorDef {
    Long id; String tenantId; String name;
    String baseUrl;                    // 必须 https，域名需审核（SSRF 防护）
    AuthType authType;                 // NONE/BASIC/BEARER/HMAC/OAUTH2
    String secretRef;                  // 指向密钥库，不明文存表
    Duration connectTimeout; Duration readTimeout;
    RetryPolicy retry;                 // 最大重试次数 + 退避策略
    List<String> allowedMethods;
}

class ConnectorInvoker {
    InvokeResult invoke(Long connectorId, String method, String path, Object body);
}
```

**必须实现的工程细节：**

- **SSRF 防护（最容易被忽略的安全洞）**：目标域名必须走白名单审核（禁止 `169.254.169.254`、`10.0.0.0/8`、`127.0.0.1`、`::1`、内网域名）；**必须在 DNS 解析后校验实际 IP**（防 DNS rebinding），且禁止跟随跳到内网的 30x。
- **密钥管理**：KMS/加密列存储，只存 `secretRef`；调用时解密注入，**日志中必须无条件脱敏**（Header/URL query 都可能带密钥，脱敏要按配置的敏感字段名单做，不能只看 body）。
- **超时与重试**：连接超时 3s / 读超时 10s 默认；只对幂等请求重试（GET/PUT/DELETE，POST 需显式开启）；重试间隔指数退避 + 抖动。
- **失败可观测**：`connector_call_log` 保留请求摘要（脱敏后）+ 响应状态 + 耗时 + traceId；提供"失败重放"（仅限非幂等副作用可控的场景，需二次确认）。
- **字段映射器**：可视化配置"响应 JSON 路径 → 平台字段"，映射规则编译为 JSONPath/JMESPath 表达式执行；映射失败要能定位到具体路径。
- **流量护栏**：单连接 QPS/日调用量上限（计入 PRD §8 护栏档位），超限告警不硬断（硬断会伤客户业务）。
- **不作为反向代理提供公网入口**：第一期只做**出站**调用，不做入站 Webhook 托管（入站要处理公网暴露、限流、签名校验、重放攻击，复杂度高一个量级）。

---

## 10. 计量与出账服务（Metering，PRD §8 落地）

**一期只采集不出账，但事件模型与聚合表必须一次设计对。**

### 10.1 事件采集链路

```
前端 usage-tracker / 后端业务埋点
        ↓ (批量, 5s 或 20 条)
POST /api/metering/events   (轻量签名 + 幂等 eventId)
        ↓
Kafka topic: metering.raw  (按 tenantId 分区保证顺序)
        ↓
metering-service 消费者:
   ① 校验签名 + 去重(eventId 幂等表, TTL 7天)
   ② 归一化 → 写明细表 (ClickHouse 或 PostgreSQL 分区表)
   ③ 增量聚合到日粒度汇总表 (usage_daily)
```

```sql
-- 明细（可外包给 ClickHouse，量大）
CREATE TABLE usage_event (
  event_id      VARCHAR(64) PRIMARY KEY,   -- 幂等键（客户端生成 UUID）
  tenant_id     BIGINT NOT NULL,
  user_id       BIGINT,
  metric        VARCHAR(64) NOT NULL,      -- seat.active / ai.tokens.in / flow.exec ...
  quantity      BIGINT NOT NULL DEFAULT 1,
  app_id        BIGINT,
  occurred_at   TIMESTAMPTZ NOT NULL,      -- 客户端事件时间（用于跨天归属）
  received_at   TIMESTAMPTZ NOT NULL,
  attrs         JSONB,                     -- 只允许 ID/枚举/数值，禁业务数据
  signature     VARCHAR(128)
);
CREATE INDEX idx_usage_tenant_metric_time ON usage_event(tenant_id, metric, occurred_at);

-- 日汇总（计费唯一读取源）
CREATE TABLE usage_daily (
  tenant_id   BIGINT, metric VARCHAR(64), stat_date DATE,
  quantity    BIGINT,
  PRIMARY KEY (tenant_id, metric, stat_date)
);
```

### 10.2 关键设计原则

| 原则 | 做法 |
|---|---|
| **明细与汇总分离** | 计费只读 `usage_daily`，明细只做对账与追溯；汇总可从明细重算（灾备/纠错） |
| **幂等** | 客户端 `eventId` + 服务端去重表；聚合任务按 `(tenant_id, metric, date)` 全量覆盖写（幂等重跑） |
| **时间归属** | 用客户端 `occurred_at` 落日期，但限制最大回溯（如 24h），超出用 `received_at`（防篡改归属月份躲避配额） |
| **活跃席位口径** | 按 `(tenant_id, user_id, date)` 去重后 count distinct，月活 = 该月内任一天出现；**必须是"有设计器写操作"才记 seat.active**，仅登录不算 |
| **迟到数据** | 允许补算 T+3 天（出账在 T+3 之后跑），出账后仍可走"账单调整"流程而不改原始汇总 |
| **防伪造** | 前端埋点只作参考（可被改包伪造），**关键计费指标（席位、AI 消耗、执行次数）必须以服务端埋点为准**，前端事件仅用于漏斗分析 |

### 10.3 配额与限流（护栏档位）

```java
// 配额扣减：Redis Lua 原子操作，避免并发超发
// KEYS[1] = quota:{tenant}:{metric}:{period}  ARGV = [需求数量, 上限]
// 返回 1=成功并扣减, 0=超限
```

- 配额检查放在网关/Dubbo Filter 前，**不在业务代码里散落判断**。
- 软限 vs 硬限：应用数/存储用软限（超限提示 + 宽限 7 天），AI 额度/执行次数用硬限（超限拒绝并返回明确错误码 + 升级引导）。
- **配额不足的错误必须区分于业务错误**（独立错误码 `QUOTA_EXCEEDED` + 升级链接），否则客户会以为系统坏了。

### 10.4 出账（Phase 3）

- 账单生成 = 定时任务读 `usage_daily` × 价格表 → 生成账单快照（**存入不可变账单表，出账后不再计算**，只允许发起"账单调整"）。
- 必须支持**账单明细可下钻**：客户质疑金额时能点开看到是哪个用户哪一天产生的——这是减少计费纠纷的关键，也是"不做出账明细"的产品最常被骂的地方。

---

## 11. 私有化部署预留（PRD §6.3，一期不做交付件）

一期纯 SaaS，但以下现在就要守（后补成本极高）：

- [ ] **外部依赖接口化**：对象存储（S3 协议抽象）、MQ、缓存、短信/邮件、LLM 全部 `interface` + 配置化实现，禁止业务代码直接调云 SDK
- [ ] **无硬编码**：域名、密钥、bucket、region 全部外置配置（Nacos/Apollo/env）
- [ ] **多租户可退化**：`TenantContext` 在单租户模式下恒返回固定值，业务代码无需分支判断
- [ ] **元表 Flyway 化**：核心元表（非用户业务表）全部 Flyway 管理，保证离线可升级
- [ ] **服务无状态**：不写本地磁盘（除临时目录），保证可容器化
- [ ] **不强依赖 SaaS 专属能力**：CDN、托管搜索、云函数等收敛到适配层
- [ ] **显式标注**：代码中禁止使用 `@CloudOnly` 未标注的云能力，CI 增加依赖扫描（如禁止 `com.aliyun.*` 直接出现在业务模块）
- 明确**不做**：License 校验、离线升级包、多形态安装器——触发条件为「首个付费私有化客户」

---

## 12. 分阶段交付建议（对应 PRD v0.2 MVP）

1. **Phase 1**：`metadata-service`（建模 + 字段状态机 DELETED + 版本快照/回滚）+ `data-engine-service`（JSONB CRUD + 读时兼容 + 字段强过滤）+ `permission-service`（基础 RBAC）+ `page-service` + **build-service 最小安全编译链路**（仅 L2 脚本：静态扫描 + esbuild 单文件编译 + artifactHash 回写，§3.4；Worker 单容器无 HPA）+ 影响面分析（页面引用 + 数据量）+ **L1 表达式引擎（Aviator 受限）** + **计量埋点采集链路（只采集不出账）** + 单租户
   > 分期修正（2026-10-28）：前端 L2 脚本（08FE）列为 P1，其保存流程依赖 build-service 产出 `artifactHash`——若编译整体后置 P2，M14 无从交付。故把 **L2 所需最小编译链路前移 P1**（红线扫描 + esbuild + 产物上传三步即闭环）；自定义组件编译（多文件/依赖白名单注入/Worker 池 HPA）仍留 P2 完整版。
2. **Phase 2**：多租户行级隔离、**代码编译服务完整版（§3.4：自定义组件多文件编译 + 白名单依赖 pre-bundle + Worker 池 HPA）**、字段级权限、`flow-service`（Flowable）、开放平台 API Key、**L4 连接器（§9.2，含 SSRF 防护）**、影响面全扫描兜底
3. **Phase 3**：**L3 沙箱执行服务（§9.1）**、Schema 级隔离、配额与出账（§10.3/10.4）、性能优化（分区表/读写分离）、AI 辅助建模网关（P3 预留，骨架契约见《详细技术文档 14》——功能范围待需求确认，一期二期不交付）、私有化交付件（按需）

---

## 13. 工程规范

- 代码规范：阿里巴巴 Java 开发手册 + Checkstyle/SpotBugs
- 单元测试：动态查询引擎、租户隔离拦截器、流程桥接层、表达式引擎覆盖率 >80%
- 契约测试：`schema-protocol-java` 与前端 TS 类型同步，CI 加 OpenAPI diff 检查
- 数据库变更：核心元表 Flyway；用户动态业务表走自建"元数据驱动 DDL 执行器"（仅涉及提升列）
- **安全清单（PR checklist 硬性项）**：新增 SQL 构建是否走白名单、新增查询是否带租户条件、新增日志是否脱敏、新增外部调用是否走连接器（禁止裸 HttpClient）
