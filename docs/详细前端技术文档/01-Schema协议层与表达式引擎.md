# 详细前端技术文档 01 · Schema 协议层与表达式引擎（schema-protocol）

> 上游：《技术方案-前端(React).md》v0.2 §3.1；PRD §7.1（L1 表达式）；《技术方案-后端(Java).md》§2（schema-protocol-java 镜像）
> 本文定位：**实现级技术设计**——类型体系、zod 运行时校验、受限表达式解释器、版本迁移管线
> 包：`packages/schema-protocol` ★全平台地基（前后端契约的前端镜像）

---

## 1. 职责边界

| 负责 | 不负责 |
|---|---|
| ModelSchema / FieldSchema / PageSchema 的 TS 类型与 zod 运行时校验 | 渲染（归 schema-renderer） |
| L1 表达式词法/语法分析、受限求值、`dependsOn` 静态提取 | 联动编排（schema-form 消费依赖） |
| schemaVersion 迁移管线（v_n → v_latest 的 transform 链） | Schema 存储/版本管理（后端 metadata/page-service） |
| 与 `schema-protocol-java` 的镜像一致性（类型 + 校验规则 + 函数白名单） | OpenAPI 文档生成（后端动态生成，本包只消费） |

## 2. 类型体系（核心定义）

```ts
// ===== 模型协议 =====
interface ModelSchema {
  id: string; modelKey: string; name: string;
  fields: FieldSchema[];
  version: number;            // 业务版本（后端 meta_model.current_version）
  schemaVersion: number;      // 协议版本 ≠ 业务版本（迁移管线依据）
}

type FieldType = 'text'|'number'|'date'|'enum'|'boolean'|'file'|'richtext'
               |'relation'|'geo'|'user'|'dept'|'computed';
type FieldStatus = 'ACTIVE'|'DELETED';          // 后端 meta_field.field_status 镜像

interface FieldSchema {
  key: string; label: string; type: FieldType;
  fieldStatus: FieldStatus;                     // 渲染层过滤依据（决策 §6.1）
  required?: boolean; uniqueFlag?: boolean; indexed?: boolean;
  defaultValue?: unknown;
  validators?: Validator[];                     // [{type:'range'|'regex'|'expression', ...}]
  enumOptions?: { value: string; label: string; color?: string; status: 'ACTIVE'|'DEPRECATED' }[];
  relation?: { targetModelId: string; cardinality: '1:1'|'1:n'|'n:n'; cascade: 'FORBID'|'SET_NULL'|'CASCADE_SOFT_DELETE' };
  computed?: { expr: ExpressionBinding; dependsOn: string[]; persistMode: 'READ_TIME'|'PERSISTED' };
  sortOrder: number;
}

// ===== 页面协议 =====
interface PageSchema {
  id: string; pageKey: string; name: string;
  type: 'FORM'|'LIST'|'DETAIL'|'DASHBOARD';
  modelId?: string; path: string;
  layout: LayoutNode[];                         // 组件树
  dataSource?: DataSourceBinding;
  actions: ActionBinding[];
  scripts?: ScriptBinding[];                    // L2 钩子绑定（详见文档 08）
  schemaVersion: number;
}

interface LayoutNode {
  id: string;                                   // 前端生成 ULID；复制页面时全量重生成
  componentName: string;                        // 必须已在物料注册表登记
  props: Record<string, PropValue>;
  children?: LayoutNode[];
  fieldRef?: string;                            // 绑定 FieldSchema.key（影响面分析数据源）
}

type PropValue = JsonPrimitive | ExpressionBinding | ActionBinding[] | LayoutNode[];

interface ExpressionBinding {                   // L1：唯一合法的表达式载体
  kind: 'expr';
  source: string;                               // '{{ amount > 10000 }}' 原文（审计/回显）
  dependsOn?: string[];                         // 保存时静态分析产物 → 后端引用登记
}

// ===== 数据源与动作（与后端统一协议对齐，后端 §5） =====
interface DataSourceBinding {
  type: 'MODEL_LIST'|'MODEL_DETAIL'|'MODEL_AGG'|'STATIC_JSON';
  modelId?: string;
  filter?: FilterNode; sort?: { field: string; order: 'asc'|'desc' }[];
  pagination?: { page: number; size: number };  // size ≤ 200（后端硬限，深翻页引导筛选）
  aggregate?: AggregateRequest;                 // MOD_AGG 专用；结构与后端 AggregateRequest 一一对应（后端文档 02 §3.6）
  staticData?: unknown;                         // STATIC_JSON 专用
}

// 聚合请求协议（Schema 协议修订：原简化版 {groupBy,fn,field} 已废弃，
// 对齐后端 02BE §3.6 冻结结构——Schema 核心数据协议评审稿 §7 行动项 #2）
interface AggregateRequest {
  measures: { fieldKey: string; func: 'SUM'|'AVG'|'COUNT'|'COUNT_DISTINCT'|'MAX'|'MIN' }[];  // 1-5 个
  group?: { fieldKey: string; topN?: number };           // 默认 topN=10，上限 50
  timeBucket?: { fieldKey: string; interval: 'DAY'|'WEEK'|'MONTH' };
}

type FilterNode =
  | { field: string; op: 'eq'|'ne'|'in'|'gt'|'gte'|'lt'|'lte'|'like'|'between'|'isNull'; value?: unknown }
  | { and: FilterNode[] } | { or: FilterNode[] };   // 过滤条件树，与后端 QueryRequest 一致

type ActionBinding =
  | { type: 'SUBMIT'; successBehavior: 'REFRESH'|'REDIRECT'|'TOAST'; redirectTo?: string }
  | { type: 'TRIGGER_FLOW'; flowId: string; bizKeyFrom: string }
  | { type: 'CALL_API'; apiName: string; paramsMapping: Record<string, PropValue> }
  | { type: 'OPEN_PAGE'; targetPageId: string; queryMapping: Record<string, PropValue> }
  | { type: 'DELETE'; confirmText?: string }
  | { type: 'CUSTOM_SCRIPT'; scriptId: string };    // L2（文档 08）
```

## 3. zod 运行时校验

```ts
const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() => z.object({
  id: z.string().min(1),
  componentName: z.string().regex(/^[A-Za-z][\w.]*$/),
  props: z.record(z.union([
    jsonPrimitiveSchema, expressionSchema,
    z.array(z.lazy(() => layoutNodeSchema)),
  ])),
  children: z.array(z.lazy(() => layoutNodeSchema)).optional(),
  fieldRef: z.string().optional(),
}));
```

- **校验时机（双保险）**：设计器保存前必过；运行时拉取 Schema 后渲染前必过（防缓存投毒与前后端版本漂移）。
- **错误定位**：zod 错误路径映射为 JSON Pointer（`/layout/2/children/0/props/visibleWhen`），设计器据此在画布定位标红节点。
- 校验失败在运行时的表现是 **SchemaError 占位页**，绝不白屏（渲染引擎 §8 分级）。

## 4. L1 表达式引擎（受限 AST 解释器）

**铁律（PRD §7.1）：禁止 `eval` / `new Function`；白名单函数；无 IO、无副作用；执行步数上限 1000。**

```
管线：Tokenizer → Pratt Parser → AST → Evaluator（同步、纯函数）

interface ExprEngine {
  compile(source: string): { ast: ExprNode } | { error: CompileError };  // 行号+列号+原因
  evaluate(ast: ExprNode, scope: Record<string, unknown>): { value: unknown } | { error: EvalError };
  extractDepends(ast: ExprNode): string[];   // 保存时产出 dependsOn → 后端引用登记
}
```

**白名单函数表（约 20 个，`functions.json` 为唯一真源）**：

| 类别 | 函数 |
|---|---|
| 日期 | `NOW()` `DATE_DIFF(a,b,unit)` `DATE_FORMAT(d,fmt)` |
| 字符串 | `CONCAT` `UPPER` `LOWER` `REPLACE` `SPLIT` `TRIM` |
| 数值 | `ROUND` `ABS` `CEIL` `FLOOR` |
| 集合 | `INCLUDES` `LENGTH` |
| 逻辑 | `&&` `\|\|` `!`（短路求值）+ 比较运算符 |

**语法层拒绝项（CompileError）**：赋值、变量声明、箭头函数、成员函数调用（`xxx.yyy()`）、非白名单标识符、`eval`/`new Function`/模板字符串内嵌表达式。

**求值层约束**：

- 标识符仅两类：白名单函数名 / scope 数据字段；引用不存在或已删除字段 → `FieldMissingError`（设计态阻断保存；运行时降级不白屏——按 PRD §3.1.1，显式报错而非静默 undefined）；
- 类型不匹配（如 `string > number`）在 compile 期做静态推断报错；
- 步数计数器：每求值一个 AST 节点 `steps++`，超过 1000 抛 `EvalBudgetError`（防深层嵌套/集合爆炸）。

**双端一致性**：流程分支/数据权限条件由后端 Aviator 求值——两边共享同一份 `functions.json`；Java 侧从该文件生成 Aviator 函数注册表，CI 做 diff 校验（§6 契约同步）。

## 5. schemaVersion 迁移管线

```
迁移链（纯函数、幂等、每个 migration 配真实历史样本快照测试）：
const migrations: Record<number, (s: AnySchema) => AnySchema> = {
  1: v1ToV2,   // 例：visibleWhen 裸字符串 → ExpressionBinding 结构化
  2: v2ToV3,
};

migrate(schema):
  if (schema.schemaVersion > LATEST)          // 来自未来的版本（缓存投毒/降级部署）
    → throw FutureSchemaVersionError          // 拒绝渲染 + 上报，这是运行时防线
  let cur = schema;
  while (cur.schemaVersion < LATEST) cur = migrations[cur.schemaVersion](cur);
  return validate(cur);                       // 迁移后仍走 zod 终验
```

- 迁移只发生在**读取侧**（设计器打开 / 运行时渲染），**不回写存储**——后端保留原始版本，保证可回溯；
- 破坏性协议升级流程：新增 schemaVersion + 配套 migration + 前后端同步发版；禁止直接修改现有字段含义。

## 6. 与后端契约同步（防漂移机制）

| 契约 | 同步方式 | CI 校验 |
|---|---|---|
| Schema 协议 | zod → `zod-to-json-schema` 导出 ↔ 后端 `schema-protocol-java` 校验规则文件 | diff 不一致即失败（**仅校验结构，不校验枚举值集合**——见下一行） |
| 字段类型枚举值集合 | `FieldType` 联合类型 ↔ 后端 `field_type` 枚举 11 种 | **待补**：结构 diff 之外追加枚举值集合专项比对（Schema 核心数据协议评审稿 §7 行动项 #1） |
| API DTO | 后端动态 OpenAPI JSON → `openapi-typescript` → `api-types.gen.ts`（禁止手写 DTO） | 后端发版触发 diff → 自动 PR |
| 表达式白名单 | `functions.json` 双端共享 | Java 生成物 diff 为空 |
| 聚合协议 | `AggregateRequest` TS 接口 ↔ 后端 02BE §3.6 同名结构 | 本次已对齐（评审稿 §7 #2 已修复），纳入结构 diff 范围 |

## 7. 单元测试硬性要求

- [ ] 全部白名单函数单测；`eval`/`new Function`/赋值/成员链调用在语法层被拒（错误含行号列号）
- [ ] 步数上限：构造深嵌套表达式触发 `EvalBudgetError`
- [ ] `dependsOn` 提取正确（含嵌套函数体内的字段引用）
- [ ] 引用 DELETED 字段：设计态 `FieldMissingError` 阻断；运行时表达式降级为安全默认值且上报
- [ ] 迁移管线：v1 样本快照迁移到 latest 后 zod 终验通过；`FutureSchemaVersionError` 用例
- [ ] 双端契约：`zod-to-json-schema` 产物与后端校验规则文件 diff 为空
