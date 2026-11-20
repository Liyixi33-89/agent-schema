/**
 * 业务 feature 契约解析测试（members/usage/notices）：
 * 覆盖正常解析、字段缺失抛 ContractError、坏行剔除、合法空列表。
 */
import { describe, expect, it } from 'vitest';
import { ContractError } from '../src/shared/contracts/contracts';
import { parseMembers } from '../src/features/members/api';
import { parseUsageSummary } from '../src/features/usage/api';
import { parseNotices } from '../src/features/notices/api';

describe('parseMembers', () => {
  it('正常解析', () => {
    expect(parseMembers({ list: [{ id: 1, account: 'a', name: '甲', status: 'ACTIVE' }] }))
      .toEqual([{ id: 1, account: 'a', name: '甲', status: 'ACTIVE' }]);
  });
  it('list 缺失抛 ContractError（不当空数据）', () => {
    expect(() => parseMembers({})).toThrow(ContractError);
    expect(() => parseMembers(null)).toThrow(ContractError);
  });
  it('空列表合法', () => {
    expect(parseMembers({ list: [] })).toEqual([]);
  });
  it('坏行剔除', () => {
    expect(parseMembers({ list: [{ id: 'x' }, { id: 2, account: 'b', status: 'DISABLED' }] }))
      .toEqual([{ id: 2, account: 'b', name: undefined, status: 'DISABLED' }]);
  });
});

describe('parseUsageSummary', () => {
  it('正常解析', () => {
    const r = parseUsageSummary({ licensedSeats: 3, activeSeats: 2, metrics: [{ metric: 'api.calls', today: 1, total: 9 }] });
    expect(r).toEqual({ licensedSeats: 3, activeSeats: 2, metrics: [{ metric: 'api.calls', today: 1, total: 9 }] });
  });
  it('席位缺失抛 ContractError', () => {
    expect(() => parseUsageSummary({ activeSeats: 2 })).toThrow(ContractError);
  });
  it('metrics 缺失 → 空数组（可选区）', () => {
    expect(parseUsageSummary({ licensedSeats: 1, activeSeats: 1 }).metrics).toEqual([]);
  });
});

describe('parseNotices', () => {
  it('正常解析（snake_case updated_at → updatedAt）', () => {
    const r = parseNotices({ list: [{ id: 1, title: 't', content: 'c', level: 'INFO', active: true, updated_at: 'x' }] });
    expect(r[0]).toMatchObject({ id: 1, active: true, updatedAt: 'x' });
  });
  it('list 缺失抛 ContractError', () => {
    expect(() => parseNotices({})).toThrow(ContractError);
  });
  it('坏行剔除', () => {
    expect(parseNotices({ list: [{ id: 1 }, { id: 2, title: 't', content: 'c', level: 'INFO', active: false }] }))
      .toHaveLength(1);
  });
});