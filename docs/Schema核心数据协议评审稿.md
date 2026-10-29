# Schema 核心数据协议评审稿

> 版本：v1.2 | 日期：2026-10-27 首发 / 2026-10-28 全量复核修订 / 2026-10-29 冻结（M1.6） | 状态：**已冻结**（v1.2：行动项 #1 落地闭环，全部契约 CI 生效，见 §7.3/§8）
> 定位：本稿是《PRD-低代码平台产品规划》§10 待办项的交付物——把分散在三篇技术文档中的 Schema 协议定义**汇总为一份可独立评审的权威视图**。
> 原则：**本稿不是协议的第二份定义**，不重复维护类型代码；每个协议元素标注唯一真源（Source of Truth）位置，本稿只做汇总、关联与一致性核验。新增/修改协议字段一律回到真源文档，本稿同步更新引用版本号。

---

## 0. 评审范围与读法

Schema 协议是全平台的"单一事实来源"：建模、渲染、流程、权限、计量五个视角都消费同一套定义。协议目前分布在：

| 真源文档 | 覆盖协议层 |
|---|---|
| 详细技术文档 01（元数据服务） | 模型/字段协议（服务端权威定义 + DDL 映射） |
| 详细前端技术文档 01（Schema 协议层） | 模型/字段/页面/表达式协议（前端 TS 镜像 + zod 校验 + 迁移管线） |
| 详细前端技术文档 05（物料体系） | 物料协议（MaterialMeta，页面协议的扩展点） |
| 详细技术文档 05（流程引擎集成） | 流程协议（FlowSchema → BPMN 映射） |
| 详细技术文档 02（数据引擎）§3.6 | 聚合协议（AggregateRequest，数据源协议的扩展） |
| 详细技术文档 03（多租户与权限） | 权限点协议（perms 串格式） |

**评审方法**：本稿按"协议对象"（而非"文档"）组织，每个对象给出 ①权威结构定义位置 ②跨端一致性保证机制 ③已验证的边界规则 ④评审结论。

---

## 1. 协议全景图

```
┌─────────────────────────────────────────────────────────────────┐
│                      Schema 协议分层（协议对象）                    │
│                                                                   │
│  模型协议 ModelSchema/FieldSchema  ──┐                            │
│   （元数据服务 01BE §2 权威；前端 01FE §2 镜像）                    │
│                                       │ fieldRef 绑定              │
│                                       ▼                           │
│  页面协议 PageSchema/LayoutNode   ──┐                            │
│   （前端 01FE §2 权威；后端仅存储透传，04BE §1）                    │
│                                       │ componentName 绑定         │
│                                       ▼                           │
│  物料协议 MaterialMeta            ──┐                            │
│   （前端 05FE §2 权威）                                           │
│                                       │                           │
│  表达式协议 ExpressionBinding      ◀──┴── 页面/流程/权限/计算字段共用│
│   （前端 01FE §4 权威 Tokenizer/Parser；functions.json 双端唯一真源）│
│                                       │                           │
│  流程协议 FlowSchema              ──┐                            │
│   （后端 05BE §2 权威：FlowSchema→BPMN 映射；前端 10FE §2 节点系统）│
│                                       │                           │
│  查询/聚合协议 QueryRequest/        ──┐                           │
│   AggregateRequest/ConditionTree     （后端 02BE §3.1/§3.2/§3.6 权威；│
│                                        前端 01FE §2 FilterNode 镜像）│
│                                                                   │
│  权限点协议 perms 串                （后端 03BE §3.2 权威格式定义）  │
└─────────────────────────────────────────────────────────────────┘
```

**判读**：模型协议是地基（字段状态机影响所有下游）；页面/流程/聚合协议都是"模型协议的消费者 + 表达式协议的宿主"；物料协议是页面协议的可扩展插槽。**任何协议变更必须先问"模型协议是否需要联动"**——这是五个视角共享同一定义的直接后果。

---

## 2. 模型协议（ModelSchema / FieldSchema）

**权威定义**：后端 `meta_model`/`meta_field` 表结构（详细技术文档 01 §2）是数据库层真源；前端 `ModelSchema`/`FieldSchema` TS 接口（详细前端技术文档 01 §2）是镜像，字段名、类型枚举、状态机值必须逐一对应。

| 维度 | 后端定义 | 前端镜像 | 一致性机制 |
|---|---|---|---|
| 字段类型 | `field_type VARCHAR(32)` 枚举 12 种 | `FieldType` 联合类型 12 种 | 手工对齐（无自动 diff，**评审发现的唯一风险点，见 §7**）；「多行文本/日期时间」为控件形态配置（text.multiline / date.withTime），不进枚举（PRD 01 §2.2.1 口径） |
| 类型可变性 | `MODIFY_FIELD` patch 白名单**不含 field_type**（01BE §4.2） | 同口径：类型创建后冻结 | 一致（2026-10-28 复核统一：换类型 = 新建字段 + 数据体检迁移，PRD 01 R4） |
| 状态机 | `field_status ENUM('ACTIVE','DELETED')` | `FieldStatus = 'ACTIVE'\|'DELETED'` | 命名完全一致，字符串字面量直接对应 |
| 版本 | `current_version INT`（业务版本）+ `meta_schema_version` 快照 | `version: number`（镜像业务版本）+ `schemaVersion`（**协议版本，与业务版本是两个概念**） | 命名上容易混淆，已在前端 01FE §2 注释中显式区分——评审确认此区分足够清晰，无需改名 |
| 关系 | `relation_config JSONB {targetModelId, cardinality, cascade}` | `relation?: {targetModelId, cardinality, cascade}` | 结构一致 |
| 计算字段 | `computed_config JSONB {expr, dependsOn, persistMode}` | `computed?: {expr: ExpressionBinding, dependsOn, persistMode}` | 一致；`expr` 在前端是结构化 `ExpressionBinding`，后端存原始表达式字符串——转换点在保存时由前端序列化（评审确认无歧义） |

**字段状态机铁律**（跨五个消费视角的核心不变式，已在后端 01BE §3 以代码层强制）：
1. `meta_field` 行永不物理 DELETE，只置状态；
2. DELETED 字段：API 默认不返回、物理列不删、JSONB 键不删；
3. 影响面分析（precheck）是变更前置闸门，三档 confirmMode（INFO/CHECKBOX/TYPE_MODEL_NAME）。

**评审结论**：✅ 定义完整、状态机单点强制、前后端镜像关系清晰。**唯一待办**：字段类型枚举目前靠人工对齐，建议补充 CI 契约测试（已在后端 01FE §6「与后端契约同步」表中列为待办——`zod-to-json-schema` diff 校验覆盖的是结构不是枚举值集合，需补充专项枚举值 diff，见 §7 行动项）。

---

## 3. 页面协议（PageSchema / LayoutNode / ExpressionBinding）

**权威定义**：前端 01FE §2（TS 接口 + zod）。后端 page-service 只做 JSONB 存储与版本管理，**不解析页面协议内部结构**（详细技术文档 04 §1），这是刻意的架构决策——页面语义只在前端消费，后端只管存储、发布快照、字段引用登记三件事。

| 协议元素 | 定义 | 跨协议引用 |
|---|---|---|
| `LayoutNode.componentName` | 字符串，指向物料注册表 | → 物料协议 `MaterialMeta.componentName`（§4） |
| `LayoutNode.fieldRef` | 指向 `FieldSchema.key` | → 模型协议（影响面分析数据源，后端 01BE §4.5 `field_reference` 登记） |
| `LayoutNode.props: PropValue` | `JsonPrimitive \| ExpressionBinding \| ActionBinding[] \| LayoutNode[]` | → 表达式协议（§5）、动作协议 |
| `DataSourceBinding` | `MODEL_LIST\|MODEL_DETAIL\|MODEL_AGG\|STATIC_JSON` | → 查询/聚合协议（§6）——**本轮评审已修复：前端早期简化版 `aggregate` 字段结构已对齐后端 02BE §3.6 冻结结构（见 §7.1）** |
| `ActionBinding` | SUBMIT/TRIGGER_FLOW/CALL_API/OPEN_PAGE/DELETE/CUSTOM_SCRIPT 六种 | → 流程协议（TRIGGER_FLOW）、L2 脚本协议（CUSTOM_SCRIPT，文档 08FE） |

**评审结论**：✅ 结构一致、职责边界清晰（后端不解析页面内部语义，避免后端承担前端渲染语义）。此前存在的 1 处协议漂移（`DataSourceBinding.aggregate`）已在本轮评审中修复，详见 §7.1。

---

## 4. 物料协议（MaterialMeta）

**权威定义**：前端 05FE §2（两轨统一协议，`runtime: 'dynamic'|'compiled'` 分派依据）。

| 字段 | 作用 | 消费方 |
|---|---|---|
| `componentName` | 全局唯一标识，命名空间 `basic.*/biz.*/custom.{tenant}.*` | 页面协议 `LayoutNode.componentName` 的合法值域 |
| `propsSchema: JSONSchema` + `x-*` 扩展关键字 | 驱动属性面板表单生成 | schema-form（属性面板是"用 schema-form 编辑 Schema"的套娃） |
| `runtime` | 轨道分派 | NodeRenderer 单入口（渲染引擎 02FE §3） |
| `acceptsDataSource`（图表物料扩展，文档 12FE §3） | 声明可用数据源类型 | 仪表盘设计器数据源绑定面板 |

**评审结论**：✅ 物料协议是页面协议的"合法扩展点"而非独立协议——`componentName` 字符串是唯一耦合点，设计干净（物料增减不影响页面协议本身的 zod schema）。两轨统一字段 `runtime` 的新增历史已在技术方案 §3.9 明确记录，无漂移。

---

## 5. 表达式协议（ExpressionBinding / L1 表达式引擎）

**权威定义**：前端 01FE §4（Tokenizer→Pratt Parser→AST→Evaluator）。`functions.json` 是白名单函数表的**唯一真源文件**，Java 侧注册表从该文件同步，CI 做 diff 校验——**✅ 状态更新（2026-10-29 M1.5 落地）**：本机制已从设计约定变为已落地事实。落地形态：① `packages/schema-protocol/contract/functions.json`（15 函数四类）；② 前端 `expression.ts` 白名单与该文件同源断言（Vitest）；③ 后端 `ExprEngine.FUNCTION_NAMES`（schema-platform/schema-protocol）与该文件逐名比对（JUnit `ExprVectorTest.whitelistMatchesFunctionsContract`）；④ `expr-test-vectors.json` 五类语义向量 28 条双端执行一致性测试（前端 Vitest + 后端 JUnit 同一份文件，结果与错误码逐条断言）。⚠️ 实现注记：后端宿主采用与前端同构的递归下降求值器（约 400 行）而非 Aviator 内核——Aviator 语法面（赋值/三元/正则字面量）宽于 L1 白名单，受限模式逐项裁剪成本高于直接同构实现；Aviator 依赖保留给流程引擎条件分支场景（05BE §2.2 Flowable conditionExpression），届时其函数注册表从同一 functions.json 生成。

**跨消费场景**（同一 AST 引擎，不同宿主）：

| 宿主 | 求值位置 | 共享内容 |
|---|---|---|
| 页面联动/属性表达式 | 前端 ExprEngine（同步） | AST 结构、白名单函数 |
| 流程条件分支 | 后端 Aviator（流程引擎 05BE §2.2） | 同一 `functions.json` 生成的函数集 |
| 数据权限自定义规则 | 后端 Aviator（权限服务 03BE §3.3） | 同上，但额外限制：仅字段 vs 当前用户属性比较，禁子查询 |
| 计算字段 | 后端（元数据服务消费，持久化模式） | 同上 |

**评审结论**：✅ 这是协议栈中设计最严谨的部分——禁止 eval/new Function、步数上限 1000、双端函数白名单单一文件生成、各宿主按场景叠加额外限制（权限规则更严）。**无需改动，建议将 `functions.json` + CI diff 的模式作为协议治理标杆，推广到 §7 的其他协议一致性缺口**。

---

## 6. 流程协议（FlowSchema）与查询/聚合协议

### 6.1 流程协议

**权威定义**：后端 05BE §2（FlowSchema → BPMN 映射表）定义节点语义；前端 10FE §2.1 定义节点类型、属性面板**与显式 `FlowSchema`/`FlowNode`/`FlowEdge`/`ApproverRule` TS 接口**（本轮评审已补充，见 §7.2）——两者是同一份协议的服务端执行语义与前端编辑语义。

**评审结论**：✅ 此前存在的文档结构缺口（流程 Schema 无独立 TS interface 定义点，功能完整但缺"一眼看到完整结构"的定义）已在本轮评审中修复，详见 §7.2。`conditionExpr`/分支表达式复用页面协议同一 `ExpressionBinding`/`ExprEngine`，`schemaVersion` 与 PageSchema 共享迁移管线实现——两点均已在前端 10FE 显式标注。

### 6.2 查询/聚合协议

**权威定义**：后端 02BE §3.2（`ConditionTree`）、§3.1（`QueryRequest`）、§3.6（`AggregateRequest`，详细技术文档 02 缺口补齐产出）；前端镜像为 01FE §2 的 `FilterNode`（与 `ConditionTree` 对应）与 `DataSourceBinding.filter/sort/pagination/aggregate`。

**评审结论**：✅ `aggregate` 字段结构漂移已在本轮评审中修复（§7.1）。操作符白名单**2026-10-28 复核发现并修复 2 处漂移**：前端 `FilterNode` 缺 `nin`（已补齐为 11 个与后端逐一对应）；前端拼写 `isNull` 与后端 `isnull` 不一致（已统一为 `isnull`）。树形态差异（前端 `{and}/{or}` vs 后端 `{op:'AND',conds}`）为**设计内差异**，由 `encodeQuery` 双端契约测试锁定（07FE §3），不算漂移。

---

## 7. 跨协议一致性矩阵与评审行动项

| # | 协议对象 | 一致性机制现状 | 风险等级 | 行动项 | 状态 |
|---|---|---|---|---|---|
| 1 | 字段类型枚举（12 种） | 人工对齐，zod diff 只校验结构不校验枚举值集合 | 🟡 中 | 补充枚举值专项 diff 测试（CI） | ✅ 已落地（2026-10-29 M1.5：contract/export/enums.json ↔ 后端枚举 JUnit 逐组比对，见 §7.3） |
| 2 | `DataSourceBinding.aggregate` vs 后端 `AggregateRequest` | 结构不一致（前端简化版未跟进后端 02BE §3.6 冻结结构） | 🔴 高（真实漂移，影响仪表盘数据绑定） | 前端 01FE §2 更新 `aggregate` 字段结构，与 `AggregateRequest` 对齐 | ✅ 已修复（§7.1） |
| 3 | 流程 Schema 结构 | 无独立 TS interface 定义点 | 🟢 低（功能不缺，只缺"一眼定义"） | 10FE 补充 `FlowSchema` 类型定义小节 | ✅ 已修复（§7.2） |
| 4 | `functions.json` 双端生成 | 已有 CI diff | ✅ 无风险 | 无需行动，作为治理样本 | — |
| 5 | 操作符白名单（ConditionTree/FilterNode） | 契约测试锁定 | ✅ 已修复（2026-10-28 复核：前端补 `nin`、拼写统一 `isnull`；此前「完全对应」结论有误） | 无需行动 | ✅ |
| 6 | 引用登记覆盖面 | ref_type 缺 SCRIPT（L2 脚本引用字段不入影响面） | 🔴 高（删字段静默破坏脚本，违背 PRD §3.1 承诺） | ref_type 加 SCRIPT + 页面服务保存脚本时静态扫描 `ctx.form.get/set` 字面量（04BE §1.4） | ✅ 已修复（2026-10-28） |
| 7 | 引用类型命名 | DDL 注释 `API_KEY` vs risks `API_CONSUMER` 两套口径 | 🟢 低 | 统一 `API_CONSUMER` | ✅ 已修复（2026-10-28） |
| 8 | 字段类型可变性 | PRD「不可改」vs 顶层 PRD/后端 02「允许改+宽松读」矛盾 | 🔴 高（产品决策冲突，实现会二选一分叉） | 统一为**类型不可变**：换类型 = 新建字段 + 数据体检迁移（PRD 01 R4/后端 01 白名单/后端 02 兼容表/顶层 PRD §6.1 五处同步） | ✅ 已修复（2026-10-28 决策） |
| 9 | textarea/datetime 类型 | PRD 清单含独立类型，前后端枚举无此二值 | 🔴 高（三端计数 12/12/14 不一致） | 定版为**控件形态配置**：text.multiline / date.withTime，不进 FieldType 枚举（PRD 01 §2.2.1 已改） | ✅ 已修复（2026-10-28 决策） |

### 7.1 本次评审即时修复（#2，已执行）

行动项 #2 是真实的协议漂移且影响面明确（仪表盘数据源绑定），评审过程中直接修复：

- 前端 01FE §2 `DataSourceBinding.aggregate` 由 `{groupBy?, fn, field?}` 改为 `AggregateRequest`（`measures[]/group?/timeBucket?`），与后端 02BE §3.6 冻结结构逐字段对应；
- 前端 01FE §6 契约同步表追加「聚合协议」行，纳入后续 `zod-to-json-schema` 结构 diff 范围（防止此类漂移再次发生而不被发现）；
- 12FE（仪表盘设计器）文档引用的 `AggregateRequest` 本就是对齐后端的正确结构，无需改动——本次修复后前端内部两处引用（协议层 01FE 与消费方 12FE）完全统一。

**结论**：行动项 #2 已闭环，不再遗留。

### 7.2 本次评审即时修复（#3，已执行）

行动项 #3 是文档结构缺口（功能设计完整，缺显式协议定义点），评审过程中直接补充：

- 前端 10FE §2.1 新增 `FlowSchema`/`FlowNode`/`FlowEdge`/`ApproverRule` 显式 TS 接口定义，与后端 05BE §2.1「FlowSchema → BPMN 映射表」逐行对应；
- 明确标注：`conditionExpr`/分支表达式复用页面协议同一 `ExpressionBinding`/`ExprEngine`（双端语义一致性的协议层面证据，而非仅口头约定）；
- 明确标注：`schemaVersion` 与 PageSchema 共享迁移管线实现（同一组 migration 函数按 schema 类型分派）——避免后续误解为两套独立版本号序列。

**结论**：行动项 #3 已闭环。此后流程协议与模型/页面协议具备同等的"一眼看到完整结构"可读性。

### 7.3 遗留行动项（已于 2026-10-29 全部闭环）

| # | 行动项 | 落地形态 | 状态 |
|---|---|---|---|
| 1 | 字段类型枚举值集合专项 CI diff | 前端 `scripts/export-enums.mjs` 导出 `contract/export/enums.json`（8 组枚举真源，types.ts 常量数组直接引用保证同源）→ 后端 `schema-protocol` 模块 `EnumContractTest` 逐组比对 Java 枚举（FieldType 12 种 / FilterOp 11 个 / ActionType 6 种，缺失即 FAIL）；已挂入 `verify.ps1` contract-diff 门禁，任何一侧漂移阻断提交 | ✅ 已落地（M1.5） |

**契约 CI 三件套生效清单（M1.6 冻结前置条件，全部已生效）**：

1. **枚举值专项 diff**——上述 #1，C-ENUM-01 存量一致性首跑即绿（文档期人工对齐无漏）；
2. **zod→json-schema 结构 diff**——前端 `scripts/export-schema.ts` 双定义同断言（zod schema 与运行时校验器对 6 组 fixture 判定必须一致才允许导出）→ `contract/export/schema.json` → 后端 `SchemaContractTest` 锁定四组核心定义、枚举嵌入、分页硬限 200、fixture 判定表；
3. **functions.json diff + expr-test-vectors 双端执行**——前端 Vitest 与后端 JUnit 跑同一份向量文件（28 条五类语义 + 步数预算），结果与错误码逐条断言一致；白名单 15 函数双端注册表与 functions.json 逐名比对。

**已知边界（非漂移，设计内差异）**：后端 JSON Schema 运行时校验器（01BE 保存链路消费）随 M2 元数据服务落地，本期锁结构与判定一致性；OpenAPI DTO 生成链路（C-API 组）依赖后端首个 Controller 出现，排 M2。
## 8. 评审结论

| 评审问题 | 结论 |
|---|---|
| Schema 核心数据协议是否已完善？ | **是（v1.1 复核后）**。六类协议对象（模型/页面/物料/表达式/流程/查询聚合）均有实现级定义，覆盖类型结构、校验规则、版本迁移、跨端一致性机制。v1.0 首评有 2 处误判（操作符「完全对应」、字段类型计 11 种）与 3 处未检出漂移（SCRIPT 引用缺失、类型可变性矛盾、textarea/datetime 三端不一致），2026-10-28 逐字段复核全部修复——**教训：跨端一致性结论必须逐值比对，不能凭「互相引用」判定对齐** |
| 是否存在协议定义本身的缺失？ | 否——本轮评审发现的 3 处问题（#1 枚举值 CI 缺口、#2 聚合协议漂移、#3 流程协议文档缺口）均为**治理/文档完整性问题**，不是协议设计空白。#2、#3 已在评审过程中修复；#1 是工程基建待办已登记排期 |
| 是否需要产出独立协议代码库（单一真源重构）？ | 不需要。现状"后端 DDL/zod 类型分别定义 + CI diff 防漂移"的**模式**经验证可行（表达式白名单 `functions.json` 是该模式的设计范本——注意是范本不是已落地事实，见 §表达式协议状态修正），扩大到枚举值级别校验即可，无需推翻为单一代码生成源 |
| 本稿是否需要持续维护？ | 是，但**低频**——仅当新增协议对象（如 AI 网关的 Prompt 协议，P3）或发现新的跨端漂移时更新；日常协议字段增删改不动本稿，只动各真源文档 |

**评审通过**。《PRD-低代码平台产品规划》§10 待办「输出《Schema 核心数据协议》评审稿」自本文档产出之日起标记为**已完成**（顶层 PRD 同步更新）。

### 8.1 冻结声明（M1.6 协议冻结评审，2026-10-29）

按《MVP 开发任务依赖顺序图》§3.2 M1.6 与 §4.3 MS1 验收门（「双端契约 CI 绿 + 评审稿无遗留高危项」）执行冻结评审：

| 冻结前置条件 | 证据 | 结论 |
|---|---|---|
| 行动项 #1 枚举专项 diff 落地 | §7.3 行动项 #1 → EnumContractTest 4 用例绿 | ✅ |
| 结构 diff 生效 | SchemaContractTest 4 用例绿（fixture 双判一致） | ✅ |
| functions.json 双端 diff | ExprVectorTest.whitelistMatchesFunctionsContract 绿 | ✅ |
| expr-test-vectors 双端执行一致 | 前端 Vitest 31 用例 + 后端 JUnit 5 用例，同一份向量文件 | ✅ |
| 评审稿无遗留高危项 | §7 矩阵 9 项全部 ✅，§7.3 清零 | ✅ |
| verify 管线全绿 | contract-diff 门禁已点亮并纳入 commit/ci 级 | ✅ |

**结论：协议冻结评审通过（MS1 达成）**。自本日起 Schema 协议进入冻结态——M2/M4/M6 解锁开工；协议字段变更须走破坏性升级流程（新增 schemaVersion + 迁移函数 + 双端同步发版，01FE §5），不允许静默改既有字段含义；本稿维持低频维护（仅新增协议对象或发现新漂移时更新）。
