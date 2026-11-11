import { describe, expect, it } from 'vitest';
import { parseListResult } from './ListPageHost';

describe('列表响应契约', () => {
  it('消费后端 list/total 包裹，不假设 rows', () => {
    expect(parseListResult({ list: [{ id: '1', title: '报销' }], total: 1 })).toEqual({
      list: [{ id: '1', title: '报销' }], total: 1,
    });
  });
  it('空列表是合法结果', () => {
    expect(parseListResult({ list: [], total: 0 })).toEqual({ list: [], total: 0 });
  });
  it('坏响应不能冒充空列表成功', () => {
    for (const value of [null, {}, { rows: [], total: 0 }, { list: [null], total: 1 }, { list: [], total: -1 }]) {
      expect(() => parseListResult(value)).toThrow();
    }
  });
});
