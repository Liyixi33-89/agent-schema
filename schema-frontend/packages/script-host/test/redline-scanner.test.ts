/**
 * 红线扫描测试：共享判定向量逐条断言（08FE §8 第一项）。
 * 真源 contract/redline-vectors.json 由前端扫描器与后端 build-service 双端消费——
 * 本文件断言前端扫描器判定；后端扫描器同判由后端契约测试保证（CI contract-diff）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource, scanGlobalAssignment } from '../src/redline-scanner';

interface Vector {
  id: string;
  source: string;
  allowed: boolean;
  rule?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, '..', 'contract', 'redline-vectors.json'), 'utf8')) as { vectors: Vector[] };

describe('redline-vectors 共享判定向量', () => {
  it('向量清单非空且 id 唯一', () => {
    expect(vectors.vectors.length).toBeGreaterThan(10);
    const ids = new Set(vectors.vectors.map((v) => v.id));
    expect(ids.size).toBe(vectors.vectors.length);
  });

  for (const v of vectors.vectors) {
    it(`${v.id} → ${v.allowed ? '放行' : '拦截 ' + v.rule}`, () => {
      const violations = [...scanSource(v.source).violations, ...scanGlobalAssignment(v.source)];
      if (v.allowed) {
        expect(violations).toEqual([]);
      } else {
        expect(violations.length).toBeGreaterThan(0);
        // with 在 ESM 下语法层不可解析 → SYNTAX_ERROR 即拦截（拦截目标天然达成）；其余须命中 rule
        if (v.rule !== 'WITH_STMT' || violations[0].rule !== 'SYNTAX_ERROR') {
          expect(violations.map((x) => x.rule)).toContain(v.rule);
        }
        // 每条违规必须有行列定位（供测试台标红与后端 CompileError）
        for (const violation of violations) {
          expect(violation.line).toBeGreaterThanOrEqual(1);
          expect(violation.column).toBeGreaterThanOrEqual(1);
          expect(violation.message.length).toBeGreaterThan(0);
        }
      }
    });
  }

  it('语法错误返回 SYNTAX_ERROR 拒绝编译（失败关闭）', () => {
    const r = scanSource('export function broken( {');
    expect(r.allowed).toBe(false);
    expect(r.violations[0].rule).toBe('SYNTAX_ERROR');
  });
});
