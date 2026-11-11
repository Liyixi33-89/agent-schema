import { describe, expect, it } from 'vitest';
import { parseListResult, resolveOpenTarget } from './ListPageHost';
import type { PageSchema } from '@schema/schema-protocol';

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

describe('行跳转目标解析（OPEN_PAGE + queryMapping）', () => {
  const base = {
    id: 'p9', pageKey: 'expense_list', name: '列表', type: 'LIST' as const,
    modelId: 'm1', path: '/list', layout: [], actions: [], schemaVersion: 1,
  };
  const row = { id: 42, title: '差旅' };

  it('无 OPEN_PAGE 动作时返回 no-action，不跳转', () => {
    const page = { ...base } as unknown as PageSchema;
    expect(resolveOpenTarget(page, row)).toEqual({ ok: false, reason: 'no-action' });
  });

  it('缺省 queryMapping 时取行 id 组装 app 域路由', () => {
    const page = { ...base, actions: [{ type: 'OPEN_PAGE', targetPageId: 'p10' }] } as unknown as PageSchema;
    expect(resolveOpenTarget(page, row, '#/app/3/page/p9')).toEqual({ ok: true, hash: '#/app/3/page/p10/42' });
  });

  it('非 app 域 hash 退化到独立页路由', () => {
    const page = { ...base, actions: [{ type: 'OPEN_PAGE', targetPageId: 'p10' }] } as unknown as PageSchema;
    expect(resolveOpenTarget(page, row, '#/page/p9')).toEqual({ ok: true, hash: '#/page/p10/42' });
  });

  it('queryMapping recordId 字段引用形态：{kind:field,source:code} 取行内字段', () => {
    const page = {
      ...base,
      actions: [{ type: 'OPEN_PAGE', targetPageId: 'p10', queryMapping: { recordId: { kind: 'field', source: 'code' } } }],
    } as unknown as PageSchema;
    expect(resolveOpenTarget(page, { code: 'R-001', id: 42 }, '#/app/3/page/p9'))
      .toEqual({ ok: true, hash: '#/app/3/page/p10/R-001' });
  });

  it('queryMapping recordId 字面量形态直接使用', () => {
    const page = {
      ...base,
      actions: [{ type: 'OPEN_PAGE', targetPageId: 'p10', queryMapping: { recordId: 'FIXED-1' } }],
    } as unknown as PageSchema;
    expect(resolveOpenTarget(page, row, '#/page/p9')).toEqual({ ok: true, hash: '#/page/p10/FIXED-1' });
  });

  it('行缺 ID 且无字面量映射时返回 no-id', () => {
    const page = { ...base, actions: [{ type: 'OPEN_PAGE', targetPageId: 'p10' }] } as unknown as PageSchema;
    expect(resolveOpenTarget(page, { title: '无 ID 行' }, '#/page/p9')).toEqual({ ok: false, reason: 'no-id' });
  });
});
