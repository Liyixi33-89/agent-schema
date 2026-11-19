import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateAppTheme } from './index';

/**
 * 双端共享校验样本（spec 019 §3 双层校验同判证明）：
 * 本文件与后端 ThemeVectorTest 消费同一份 theme-fixtures.json——
 * 逐条断言 ok 判定与错误锚点，白名单语义双端漂移即红。
 */
const fixtures = JSON.parse(
  readFileSync(join(__dirname, '..', 'test', 'theme-fixtures.json'), 'utf8'),
) as { cases: Array<{ id: string; input: unknown; ok: boolean; errContains?: string[] }> };

describe('theme-fixtures 双端共享样本同判', () => {
  it('样本文件非空且 id 唯一', () => {
    expect(fixtures.cases.length).toBeGreaterThanOrEqual(15);
    expect(new Set(fixtures.cases.map((c) => c.id)).size).toBe(fixtures.cases.length);
  });

  for (const c of fixtures.cases) {
    it(`[${c.ok ? 'accept' : 'reject'}] ${c.id}`, () => {
      const r = validateAppTheme(c.input);
      expect(r.ok).toBe(c.ok);
      if (!c.ok) {
        expect(r.errors.length).toBeGreaterThan(0);
        for (const anchor of c.errContains ?? []) {
          expect(r.errors.join('；')).toContain(anchor);
        }
      }
    });
  }
});
