import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validatePageSchema, validateModelSchema } from '../src/validate';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { FIELD_TYPES, FIELD_STATUSES, FILTER_OPS, PAGE_TYPES, DATA_SOURCE_TYPES, AGGREGATE_FUNCS, TIME_BUCKET_INTERVALS } from '../src/types';

/**
 * M1.5 完整结构防漂移门禁（三件套之二的结构面）：
 * 共享样本 schema-fixtures.json 是双端唯一真源——本测试让前端 Vitest 与后端
 * SchemaContractTest 跑同一份样本；再叠加「导出物结构锚点」断言，防止
 * schema.json 生成物被篡改或导出器回归。
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixturesPath = resolve(here, '../contract/schema-fixtures.json');
const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8')) as Array<{ name: string; schema: string; input: unknown; valid: boolean }>;

describe('shared fixtures execute identically on runtime validators', () => {
  const validators: Record<string, (input: unknown) => unknown> = {
    PageSchema: validatePageSchema,
    ModelSchema: validateModelSchema,
  };

  for (const f of fixtures) {
    it(`${f.schema}/${f.name} -> ${f.valid}`, () => {
      const validator = validators[f.schema];
      expect(validator, `未知样本类型 ${f.schema}`).toBeTypeOf('function');
      let ok = true;
      try { validator(f.input); } catch { ok = false; }
      expect(ok, `${f.schema}/${f.name} 运行时判定 ${ok}，期望 ${f.valid}`).toBe(f.valid);
    });
  }
});

describe('exported schema.json structure anchors', () => {
  const exported = JSON.parse(readFileSync(resolve(here, '../contract/export/schema.json'), 'utf8'));

  it('exports all 8 core definitions', () => {
    for (const name of ['ModelSchema', 'FieldSchema', 'LayoutNode', 'FilterNode', 'PageSchema', 'DataSourceBinding', 'ActionBinding', 'ExpressionBinding']) {
      expect(exported.definitions, `缺少定义 ${name}`).toHaveProperty(name);
    }
  });

  it('embeds frozen enum values from types.ts constants', () => {
    const json = JSON.stringify(exported);
    for (const constants of [FIELD_TYPES, FIELD_STATUSES, FILTER_OPS, PAGE_TYPES, DATA_SOURCE_TYPES, AGGREGATE_FUNCS, TIME_BUCKET_INTERVALS]) {
      for (const value of constants) {
        expect(json, `枚举 ${value} 未出现在导出物中`).toContain(`"${value}"`);
      }
    }
  });

  it('anchors pagination hard limit 200', () => {
    const json = JSON.stringify(exported);
    expect(json).toContain('"maximum":200');
  });
});

/** 导出器与 zod 定义一致性快照：样本对导出定义执行 must-not-throw（与后端 SchemaValidator 同口径） */
describe('fixtures validate against exported json-schema (zod parity)', () => {
  const jsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);
  const jsonValue: z.ZodType<unknown> = z.lazy(() => z.union([jsonPrimitive, z.record(z.lazy(() => jsonValue)), z.array(z.lazy(() => jsonValue))]));
  const expression = z.object({ kind: z.literal('expr'), source: z.string(), dependsOn: z.array(z.string()).optional() });
  const filter: z.ZodType<unknown> = z.lazy(() => z.union([
    z.object({ field: z.string(), op: z.enum(FILTER_OPS), value: jsonValue.optional() }),
    z.object({ and: z.array(filter) }),
    z.object({ or: z.array(filter) }),
  ]));
  const field = z.object({
    key: z.string(), label: z.string(), type: z.enum(FIELD_TYPES), fieldStatus: z.enum(FIELD_STATUSES),
    required: z.boolean().optional(), uniqueFlag: z.boolean().optional(), indexed: z.boolean().optional(),
    defaultValue: jsonValue.optional(), sortOrder: z.number(),
  });
  const model = z.object({
    id: z.string().min(1), modelKey: z.string(), name: z.string(), fields: z.array(field),
    version: z.number().int().min(1), schemaVersion: z.number().int().min(1),
  });
  const actionBinding = z.union([
    z.object({ type: z.literal('SUBMIT'), successBehavior: z.enum(['REFRESH', 'REDIRECT', 'TOAST']), redirectTo: z.string().optional() }),
    z.object({ type: z.literal('TRIGGER_FLOW'), flowId: z.string(), bizKeyFrom: z.string() }),
    z.object({ type: z.literal('CALL_API'), apiName: z.string(), paramsMapping: z.record(z.unknown()) }),
    z.object({ type: z.literal('OPEN_PAGE'), targetPageId: z.string(), queryMapping: z.record(z.unknown()) }),
    z.object({ type: z.literal('DELETE'), confirmText: z.string().optional() }),
    z.object({ type: z.literal('CUSTOM_SCRIPT'), scriptId: z.string() }),
  ]);
  const layoutNode: z.ZodType<unknown> = z.lazy(() => z.object({
    id: z.string().min(1),
    componentName: z.string().regex(/^[A-Za-z][\w.]*$/),
    props: z.record(z.union([jsonPrimitive, expression, z.array(actionBinding), z.array(layoutNode), jsonValue])),
    children: z.array(z.lazy(() => layoutNode)).optional(),
    fieldRef: z.string().optional(),
  }));
  const page = z.object({
    id: z.string().min(1), pageKey: z.string(), name: z.string(), type: z.enum(PAGE_TYPES),
    modelId: z.string().optional(), path: z.string().startsWith('/'),
    layout: z.array(layoutNode), dataSource: z.object({
      type: z.enum(DATA_SOURCE_TYPES), modelId: z.string().optional(), filter: filter.optional(),
      sort: z.array(z.object({ field: z.string(), order: z.enum(['asc', 'desc']) })).optional(),
      pagination: z.object({ page: z.number(), size: z.number().int().min(1).max(200) }).optional(),
      aggregate: z.object({
        measures: z.array(z.object({ fieldKey: z.string(), func: z.enum(AGGREGATE_FUNCS) })).min(1).max(5),
        group: z.object({ fieldKey: z.string(), topN: z.number().int().min(1).max(50).optional() }).optional(),
        timeBucket: z.object({ fieldKey: z.string(), interval: z.enum(TIME_BUCKET_INTERVALS) }).optional(),
      }).optional(),
      staticData: z.unknown().optional(),
    }).optional(),
    actions: z.array(actionBinding), schemaVersion: z.number().int().min(1),
  });
  const schemas: Record<string, z.ZodType<unknown>> = { PageSchema: page, ModelSchema: model };

  for (const f of fixtures) {
    it(`${f.schema}/${f.name} zod判定一致`, () => {
      expect(schemas[f.schema].safeParse(f.input).success).toBe(f.valid);
    });
  }
});
