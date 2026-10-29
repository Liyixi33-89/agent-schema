import { describe, expect, it } from 'vitest';
import { compile, evaluate, extractDepends, EvalBudgetError, FieldMissingError, FUNCTION_NAMES } from '../src/expression';
import functionsContract from '../contract/functions.json';
import { migrate, FutureSchemaVersionError, LATEST_SCHEMA_VERSION } from '../src/migration';
import { validatePageSchema, SchemaValidationError } from '../src/validate';
import type { PageSchema } from '../src/types';

/** 白名单函数名与 contract/functions.json 唯一真源一致（M1.5 枚举 diff 的前置防线） */
describe('expression contract', () => {
  it('registered functions match contract/functions.json', () => {
    const contractNames = (functionsContract as { name: string }[]).map((f) => f.name).sort();
    expect(FUNCTION_NAMES.sort()).toEqual(contractNames);
  });

  it('rejects assignment, arrow function, member call and template literal', () => {
    const cases = ['a = 1', 'items.map(x => x * 2)', 'order.toFixed(2)', '`abc`', 'a;b'];
    for (const src of cases) {
      const result = compile(src);
      expect(result, src).toHaveProperty('error');
    }
  });

  it('compile errors carry line and column', () => {
    const result = compile('amount + ');
    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.error.line).toBeGreaterThanOrEqual(1);
      expect(result.error.column).toBeGreaterThanOrEqual(1);
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });
});

describe('expression semantics (test-vector semantics from 01FE §4)', () => {
  const evalExpr = (src: string, scope: Record<string, unknown> = {}, clock?: () => Date) => {
    const compiled = compile(src);
    if ('error' in compiled) throw new Error(`compile failed: ${compiled.error.message}`);
    const result = evaluate(compiled.ast, scope, clock);
    if ('error' in result) throw new Error(result.error.message);
    return result.value;
  };

  it('DATE_DIFF in DAY units', () => {
    expect(evalExpr("DATE_DIFF('2026-01-02','2026-01-01','DAY')")).toBe(1);
  });

  it('NOW() uses injected UTC clock for DATE_FORMAT', () => {
    const fixed = new Date('2026-02-03T05:06:07Z');
    expect(evalExpr("DATE_FORMAT(NOW(),'YYYY-MM-DD')", {}, () => fixed)).toBe('2026-02-03');
  });

  it('null propagates: null + 1 → null, null == \'\' → false, CONCAT skips null', () => {
    expect(evalExpr('missing + 1', { missing: null })).toBe(null);
    expect(evalExpr("missing == ''", { missing: null })).toBe(false);
    expect(evalExpr("CONCAT(missing,'a')", { missing: null })).toBe('a');
  });

  it('ROUND uses half-up on floating artifacts', () => {
    expect(evalExpr('ROUND(0.1+0.2, 1)')).toBe(0.3);
  });

  it('short-circuit: false && (1/0) does not throw', () => {
    expect(evalExpr('false && (1/0)')).toBe(false);
  });

  it('LENGTH(null) → 0 per frozen vector', () => {
    expect(evalExpr('LENGTH(null)')).toBe(0);
  });

  it('INCLUDES on null list → false', () => {
    expect(evalExpr('INCLUDES(tags, \'a\')', { tags: null })).toBe(false);
  });

  it('type mismatch in comparison fails evaluation', () => {
    const compiled = compile("'5' > 3");
    expect(compiled).toHaveProperty('ast');
    if ('ast' in compiled) {
      const result = evaluate(compiled.ast, {});
      expect(result).toHaveProperty('error');
    }
  });

  it('unknown identifier yields FieldMissingError', () => {
    const compiled = compile('notExist');
    expect(compiled).toHaveProperty('ast');
    if ('ast' in compiled) {
      const result = evaluate(compiled.ast, {});
      expect(result).toHaveProperty('error');
      if ('error' in result) expect(result.error.code).toBe('FieldMissingError');
    }
  });

  it('evaluation budget aborts runaway nesting', () => {
    const src = '1' + ' + 1'.repeat(1200);
    const compiled = compile(src);
    expect(compiled).toHaveProperty('ast');
    if ('ast' in compiled) {
      const result = evaluate(compiled.ast, {});
      expect(result).toHaveProperty('error');
      if ('error' in result) expect(result.error.code).toBe('EvalBudgetError');
    }
    expect(() => {
      const c = compile(src);
      if ('ast' in c) {
        const r = evaluate(c.ast, {});
        if ('value' in r) return;
        throw new EvalBudgetError();
      }
    }).toThrow();
  });

  it('dependsOn extraction covers nested call bodies', () => {
    const compiled = compile("CONCAT(UPPER(name),'-',ROUND(amount, 1))");
    expect(compiled).toHaveProperty('ast');
    if ('ast' in compiled) {
      expect(extractDepends(compiled.ast).sort()).toEqual(['amount', 'name']);
    }
  });
});

describe('schemaVersion migration', () => {
  const sample = {
    id: 'p1', pageKey: 'page', name: 'Page', type: 'LIST', path: '/x',
    layout: [], actions: [], schemaVersion: 1,
  } as unknown as PageSchema;

  it('returns a clone without mutating the original (read-side only)', () => {
    const migrated = migrate(sample);
    expect(migrated).toEqual(sample);
    expect(migrated).not.toBe(sample);
  });

  it('rejects future schemaVersion', () => {
    expect(() => migrate({ ...sample, schemaVersion: LATEST_SCHEMA_VERSION + 1 })).toThrow(FutureSchemaVersionError);
  });

  it('rejects invalid schemaVersion', () => {
    expect(() => migrate({ ...sample, schemaVersion: 0 })).toThrow();
  });
});

describe('page schema validation', () => {
  const validPage = {
    id: 'p1', pageKey: 'page', name: 'Page', type: 'LIST', path: '/list',
    schemaVersion: 1, layout: [], actions: [],
  };

  it('accepts a valid page with nested expr props', () => {
    const page = {
      ...validPage,
      layout: [{
        id: 'n1', componentName: 'Button',
        props: { visibleWhen: { kind: 'expr', source: '{{ amount > 100 }}' }, title: 'ok' },
      }],
    };
    expect(validatePageSchema(page).id).toBe('p1');
  });

  it('reports JSON Pointer for invalid nested node', () => {
    const page = {
      ...validPage,
      layout: [{ id: 'n1', componentName: 'Button', props: {}, children: [{ id: '', componentName: 'Bad!', props: {} }] }],
    };
    try {
      validatePageSchema(page);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaValidationError);
      const pointers = (e as SchemaValidationError).pointers;
      expect(pointers.some((p) => p.startsWith('/layout/0/children/0'))).toBe(true);
    }
  });

  it('rejects oversized pagination beyond backend hard limit', () => {
    const page = { ...validPage, dataSource: { type: 'MODEL_LIST', pagination: { page: 1, size: 201 } } };
    expect(() => validatePageSchema(page)).toThrow(SchemaValidationError);
  });

  it('rejects unknown action type with pointer', () => {
    const page = { ...validPage, actions: [{ type: 'UNKNOWN' }] };
    try {
      validatePageSchema(page);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as SchemaValidationError).pointers.some((p) => p.startsWith('/actions/0'))).toBe(true);
    }
  });
});
