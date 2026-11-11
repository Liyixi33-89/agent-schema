import { describe, expect, it } from 'vitest';
import { parseRuntimeHash } from './route';

describe('运行时路由', () => {
  it('保留应用壳内详情记录 ID，刷新可恢复', () => {
    expect(parseRuntimeHash('#/app/1/page/2/987654321')).toEqual({
      kind: 'app', appId: '1', pageId: '2', recordId: '987654321',
    });
  });
  it('兼容应用首页与登记页', () => {
    expect(parseRuntimeHash('#/app/1')).toEqual({ kind: 'app', appId: '1' });
    expect(parseRuntimeHash('#/app/1/page/2')).toEqual({ kind: 'app', appId: '1', pageId: '2' });
  });
  it('兼容裸详情和预览凭证路由', () => {
    expect(parseRuntimeHash('#/page/2/3')).toEqual({ kind: 'page', pageId: '2', recordId: '3' });
    expect(parseRuntimeHash('#/preview?grant=abc-123')).toEqual({ kind: 'preview', grantId: 'abc-123' });
  });
  it('拒绝截断匹配和非法记录 ID', () => {
    for (const hash of ['#/app/1/page/2/abc', '#/page/2/3/4', '#/app/1/unknown', '']) {
      expect(parseRuntimeHash(hash)).toBeNull();
    }
  });
});
