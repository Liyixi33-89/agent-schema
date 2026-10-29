import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, evaluate } from '../src/expression';

interface Vector {
  id: string;
  category: string;
  source: string;
  scope: Record<string, unknown>;
  clock?: string;
  expect: { value?: unknown } | { error: string };
}

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(here, '../contract/expr-test-vectors.json');
const vectors: Vector[] = JSON.parse(readFileSync(vectorsPath, 'utf8'));

describe('expr-test-vectors (双端共享语义向量 · 前端执行器)', () => {
  it('向量文件非空且分类覆盖五类语义', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(20);
    const categories = new Set(vectors.map((v) => v.category));
    for (const required of ['日期时区', '空值传播', '数值精度', '短路求值', '类型转换']) {
      expect(categories, `缺少分类 ${required}`).toContain(required);
    }
  });

  for (const v of vectors) {
    it(`${v.id} (${v.category}) ${v.source}`, () => {
      const compiled = compile(v.source);
      expect(compiled, `${v.id} 编译失败`).toHaveProperty('ast');
      if (!('ast' in compiled)) return;
      const clock = v.clock ? () => new Date(v.clock!) : undefined;
      const result = evaluate(compiled.ast, v.scope, clock);
      if ('value' in v.expect) {
        expect(result, `${v.id} 应为值结果`).toHaveProperty('value');
        if ('value' in result) expect(result.value).toEqual(v.expect.value);
      } else {
        expect(result, `${v.id} 应为错误结果`).toHaveProperty('error');
        if ('error' in result) expect(result.error.code).toBe((v.expect as { error: string }).error);
      }
    });
  }

  it('步数预算向量：深嵌套触发 EvalBudgetError', () => {
    const src = '1'.concat(' + 1'.repeat(1200));
    const compiled = compile(src);
    expect(compiled).toHaveProperty('ast');
    if ('ast' in compiled) {
      const result = evaluate(compiled.ast, {});
      expect(result).toHaveProperty('error');
      if ('error' in result) expect(result.error.code).toBe('EvalBudgetError');
    }
  });
});
