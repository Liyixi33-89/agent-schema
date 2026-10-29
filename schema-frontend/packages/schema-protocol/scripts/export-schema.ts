/**
 * zod → JSON Schema 导出脚本（M1.5 契约 CI 三件套之二：结构 diff）。
 * 手写校验器（src/validate.ts）与 zod schema 在本脚本内以「双定义同断言」方式绑定：
 * 同一批 fixture 既过 validatePageSchema 又过 zod schema，两者判定不一致即导出失败——
 * 防止 zod 定义与运行时校验器漂移（zod 版定义见 docs/详细前端技术文档/01 §3）。
 *
 * 产物：contract/export/schema.json（唯一真源），后端 JUnit 加载比对（SchemaContractTest）。
 * 运行：pnpm --filter @schema/schema-protocol run export:schema
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { validatePageSchema } from '../src/validate';
import { FIELD_TYPES, FIELD_STATUSES, FILTER_OPS, PAGE_TYPES, DATA_SOURCE_TYPES, AGGREGATE_FUNCS, TIME_BUCKET_INTERVALS } from '../src/types';

// ===== zod schema（与 01FE §3 定义逐支对齐） =====
const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.record(z.lazy(() => jsonValueSchema)), z.array(z.lazy(() => jsonValueSchema))]),
);
const expressionSchema = z.object({ kind: z.literal('expr'), source: z.string(), dependsOn: z.array(z.string()).optional() });
const actionBindingSchema = z.union([
  z.object({ type: z.literal('SUBMIT'), successBehavior: z.enum(['REFRESH', 'REDIRECT', 'TOAST']), redirectTo: z.string().optional() }),
  z.object({ type: z.literal('TRIGGER_FLOW'), flowId: z.string(), bizKeyFrom: z.string() }),
  z.object({ type: z.literal('CALL_API'), apiName: z.string(), paramsMapping: z.record(z.unknown()) }),
  z.object({ type: z.literal('OPEN_PAGE'), targetPageId: z.string(), queryMapping: z.record(z.unknown()) }),
  z.object({ type: z.literal('DELETE'), confirmText: z.string().optional() }),
  z.object({ type: z.literal('CUSTOM_SCRIPT'), scriptId: z.string() }),
]);
const layoutNodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    componentName: z.string().regex(/^[A-Za-z][\w.]*$/),
    props: z.record(z.union([jsonPrimitiveSchema, expressionSchema, z.array(actionBindingSchema), z.lazy(() => z.array(layoutNodeSchema)), jsonValueSchema])),
    children: z.array(z.lazy(() => layoutNodeSchema)).optional(),
    fieldRef: z.string().optional(),
  }),
);
const filterSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.object({ field: z.string(), op: z.enum(FILTER_OPS), value: jsonValueSchema.optional() }),
  z.object({ and: z.array(filterSchema) }),
  z.object({ or: z.array(filterSchema) }),
]));
const fieldSchema = z.object({
  key: z.string(), label: z.string(), type: z.enum(FIELD_TYPES), fieldStatus: z.enum(FIELD_STATUSES),
  required: z.boolean().optional(), uniqueFlag: z.boolean().optional(), indexed: z.boolean().optional(),
  defaultValue: jsonValueSchema.optional(), sortOrder: z.number(),
  enumOptions: z.array(z.object({ value: z.string(), label: z.string(), color: z.string().optional(), status: z.enum(['ACTIVE', 'DEPRECATED']) })).optional(),
  relation: z.object({ targetModelId: z.string(), cardinality: z.enum(['1:1', '1:n', 'n:n']), cascade: z.enum(['FORBID', 'SET_NULL', 'CASCADE_SOFT_DELETE']) }).optional(),
  computed: z.object({ expr: expressionSchema, dependsOn: z.array(z.string()), persistMode: z.enum(['READ_TIME', 'PERSISTED']) }).optional(),
});
const modelSchema = z.object({
  id: z.string().min(1), modelKey: z.string(), name: z.string(), fields: z.array(fieldSchema),
  version: z.number().int().min(1), schemaVersion: z.number().int().min(1),
});
const dataSourceSchema = z.object({
  type: z.enum(DATA_SOURCE_TYPES),
  modelId: z.string().optional(),
  filter: filterSchema.optional(),
  sort: z.array(z.object({ field: z.string(), order: z.enum(['asc', 'desc']) })).optional(),
  pagination: z.object({ page: z.number(), size: z.number().int().min(1).max(200) }).optional(),
  aggregate: z.object({
    measures: z.array(z.object({ fieldKey: z.string(), func: z.enum(['SUM', 'AVG', 'COUNT', 'COUNT_DISTINCT', 'MAX', 'MIN']) })).min(1).max(5),
    group: z.object({ fieldKey: z.string(), topN: z.number().int().min(1).max(50).optional() }).optional(),
    timeBucket: z.object({ fieldKey: z.string(), interval: z.enum(['DAY', 'WEEK', 'MONTH']) }).optional(),
  }).optional(),
  staticData: z.unknown().optional(),
});
const pageSchema = z.object({
  id: z.string().min(1),
  pageKey: z.string(),
  name: z.string(),
  type: z.enum(['FORM', 'LIST', 'DETAIL', 'DASHBOARD']),
  modelId: z.string().optional(),
  path: z.string().startsWith('/'),
  layout: z.array(layoutNodeSchema),
  dataSource: dataSourceSchema.optional(),
  actions: z.array(actionBindingSchema),
  schemaVersion: z.number().int().min(1),
});

// ===== 双定义一致性断言：同一 fixture 必须双判一致 =====
const fixtures: Array<{ name: string; input: unknown; valid: boolean }> = [
  {
    name: 'minimal-valid',
    input: { id: 'p1', pageKey: 'page', name: 'Page', type: 'LIST', path: '/x', layout: [], actions: [], schemaVersion: 1 },
    valid: true,
  },
  {
    name: 'expr-prop',
    input: {
      id: 'p1', pageKey: 'page', name: 'Page', type: 'FORM', path: '/f', schemaVersion: 1,
      layout: [{ id: 'n1', componentName: 'Input', props: { visibleWhen: { kind: 'expr', source: '{{a>1}}' } } }],
      actions: [],
    },
    valid: true,
  },
  {
    name: 'bad-action',
    input: { id: 'p1', pageKey: 'page', name: 'Page', type: 'LIST', path: '/x', layout: [], actions: [{ type: 'UNKNOWN' }], schemaVersion: 1 },
    valid: false,
  },
  {
    name: 'oversize-pagination',
    input: {
      id: 'p1', pageKey: 'page', name: 'Page', type: 'LIST', path: '/x', layout: [], actions: [], schemaVersion: 1,
      dataSource: { type: 'MODEL_LIST', pagination: { page: 1, size: 201 } },
    },
    valid: false,
  },
  {
    name: 'bad-component-name',
    input: {
      id: 'p1', pageKey: 'page', name: 'Page', type: 'LIST', path: '/x', actions: [], schemaVersion: 1,
      layout: [{ id: 'n1', componentName: 'Bad!', props: {} }],
    },
    valid: false,
  },
  {
    name: 'agg-structure',
    input: {
      id: 'p1', pageKey: 'page', name: 'Page', type: 'DASHBOARD', path: '/d', layout: [], actions: [], schemaVersion: 1,
      dataSource: { type: 'MODEL_AGG', aggregate: { measures: [{ fieldKey: 'amount', func: 'SUM' }], timeBucket: { fieldKey: 'createdAt', interval: 'MONTH' } } },
    },
    valid: true,
  },
];

const modelFixtures = [
  { name: 'model-valid', input: { id: 'm1', modelKey: 'orders', name: 'Orders', fields: [{ key: 'amount', label: 'Amount', type: 'number', fieldStatus: 'ACTIVE', sortOrder: 0 }], version: 1, schemaVersion: 1 }, valid: true },
  { name: 'model-invalid-field-type', input: { id: 'm1', modelKey: 'orders', name: 'Orders', fields: [{ key: 'amount', label: 'Amount', type: 'datetime', fieldStatus: 'ACTIVE', sortOrder: 0 }], version: 1, schemaVersion: 1 }, valid: false },
];
for (const f of modelFixtures) {
  if (modelSchema.safeParse(f.input).success !== f.valid) throw new Error(`模型样本判定失败: ${f.name}`);
}

const disagreements: string[] = [];
for (const f of fixtures) {
  const zodOk = pageSchema.safeParse(f.input).success;
  let runtimeOk = true;
  try { validatePageSchema(f.input); } catch { runtimeOk = false; }
  if (zodOk !== f.valid) disagreements.push(`zod 对 ${f.name} 判定 ${zodOk}，期望 ${f.valid}`);
  if (runtimeOk !== f.valid) disagreements.push(`运行时校验器对 ${f.name} 判定 ${runtimeOk}，期望 ${f.valid}`);
}
if (disagreements.length > 0) {
  console.error('[export-schema] 双定义判定不一致:\n' + disagreements.join('\n'));
  process.exit(1);
}

// ===== 导出 =====
const exported = {
  schemaVersion: 1,
  exportedAt: 'build-time',
  definitions: {
    ModelSchema: zodToJsonSchema(modelSchema, { target: 'draft-7', name: 'ModelSchema' }),
    FieldSchema: zodToJsonSchema(fieldSchema, { target: 'draft-7', name: 'FieldSchema' }),
    LayoutNode: zodToJsonSchema(layoutNodeSchema, { target: 'draft-7', name: 'LayoutNode' }),
    FilterNode: zodToJsonSchema(filterSchema, { target: 'draft-7', name: 'FilterNode' }),
    PageSchema: zodToJsonSchema(pageSchema, { target: 'draft-7', name: 'PageSchema' }),
    DataSourceBinding: zodToJsonSchema(dataSourceSchema, { target: 'draft-7', name: 'DataSourceBinding' }),
    ActionBinding: zodToJsonSchema(actionBindingSchema, { target: 'draft-7', name: 'ActionBinding' }),
    ExpressionBinding: zodToJsonSchema(expressionSchema, { target: 'draft-7', name: 'ExpressionBinding' }),
  },
  fixtureVerdicts: Object.fromEntries(fixtures.map((f) => [f.name, f.valid])),
};

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../contract/export');
mkdirSync(outDir, { recursive: true });
const outFile = resolve(outDir, 'schema.json');
writeFileSync(outFile, `${JSON.stringify(exported, null, 2)}\n`, 'utf8');
writeFileSync(resolve(here, '../contract/schema-fixtures.json'), `${JSON.stringify([
  ...fixtures.map((f) => ({ ...f, schema: 'PageSchema' })),
  ...modelFixtures.map((f) => ({ ...f, schema: 'ModelSchema' })),
], null, 2)}\n`, 'utf8');
console.log(`[export-schema] ${fixtures.length} fixtures 双判一致，导出 ${Object.keys(exported.definitions).length} 组定义 -> ${outFile}`);
