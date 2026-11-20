/**
 * 契约层回归测试（阶段 C 范例）：
 * 覆盖：正常响应、字段缺失抛 ContractError、null、非法统计值、SLA 无样本不转 100%、
 *       时序部分坏行剔除、合法空样本（series: []）与损坏响应严格区分、
 *       维护窗口字段映射（snake_case→camelCase）。
 */
import { describe, expect, it } from 'vitest';
import {
  ContractError, parseCompile, parseHealthInfo, parseMaintenanceWindows, parseRecentErrors,
  parseSlaMonthly, parseTenantOverview, parseThroughput, parseYearMonth,
} from '../src/shared/contracts/contracts';
import statusTag from '../src/shared/ui/HealthSummary';
import React from 'react';

const HEALTH_OK = { status: 'UP', db: 'UP', version: '0.1.0', timestamp: '2026-11-20T10:00:00Z' };
const OVERVIEW_OK = {
  db: 'UP', activeUsersLastHour: 5, timestamp: '2026-11-20T10:00:00Z',
  apiThroughputLastHour: { calls: 120, source: 'metering' },
  errorRateLastHour: { errors: 2, source: 'audit+compile' },
  scriptCompileLastHour: { total: 10, success: 9, successRate: 0.9 },
  resourceUsage: { storageMb: 2048 },
};
const SLA_OK = {
  yearMonth: '2026-11', targetSla: 0.999, availability: 0.9995,
  totalMinutes: 43200, excludedMaintenanceMinutes: 60, effectiveMinutes: 43140,
  unavailableMinutes: 5, incidents: [{ startAt: '2026-11-01T02:00:00Z', minutes: 5 }],
  sampledMinutes: 40000,
  basis: { measurement: 'probe', unavailableRule: '>=5min', exclusion: 'maintenance', source: 'ops' },
};

describe('parseHealthInfo', () => {
  it('正常响应解析', () => {
    expect(parseHealthInfo(HEALTH_OK)).toEqual(HEALTH_OK);
  });
  it('缺 timestamp 抛 ContractError（不猜测补值）', () => {
    expect(() => parseHealthInfo({ ...HEALTH_OK, timestamp: undefined })).toThrow(ContractError);
  });
  it('null/非对象抛 ContractError', () => {
    expect(() => parseHealthInfo(null)).toThrow(ContractError);
    expect(() => parseHealthInfo('UP')).toThrow(ContractError);
  });
});

describe('parseTenantOverview', () => {
  it('正常响应解析', () => {
    const r = parseTenantOverview(OVERVIEW_OK);
    expect(r.scriptCompileLastHour.successRate).toBe(0.9);
  });
  it('successRate null 合法（采样中）', () => {
    const r = parseTenantOverview({ ...OVERVIEW_OK, scriptCompileLastHour: { total: 0, success: 0, successRate: null } });
    expect(r.scriptCompileLastHour.successRate).toBeNull();
  });
  it('successRate 非数字非 null 抛错（非法统计值）', () => {
    expect(() => parseTenantOverview({ ...OVERVIEW_OK, scriptCompileLastHour: { total: 1, success: 1, successRate: '99%' } })).toThrow(ContractError);
  });
  it('嵌套对象缺失抛错', () => {
    expect(() => parseTenantOverview({ ...OVERVIEW_OK, apiThroughputLastHour: null })).toThrow(ContractError);
  });
  it('activeUsers NaN 抛错', () => {
    expect(() => parseTenantOverview({ ...OVERVIEW_OK, activeUsersLastHour: NaN })).toThrow(ContractError);
  });
});

describe('parseThroughput / parseCompile（时序）', () => {
  it('正常序列', () => {
    expect(parseThroughput({ series: [{ minute: '10:00', calls: 3 }] })).toEqual([{ minute: '10:00', calls: 3 }]);
  });
  it('series 缺失/非数组 → 抛 ContractError（损坏响应，不当空样本）', () => {
    expect(() => parseThroughput({})).toThrow(ContractError);
    expect(() => parseThroughput({ series: null })).toThrow(ContractError);
  });
  it('series 空数组 → []（合法无样本，与损坏响应区分）', () => {
    expect(parseThroughput({ series: [] })).toEqual([]);
  });
  it('部分坏行剔除不丢整段', () => {
    const r = parseCompile({ series: [
      { hour: '08', total: 2, success: 2, failed: 0, blocked: 0, medianDurationMs: null },
      { hour: '09', total: 'x', success: 1, failed: 0, blocked: 0, medianDurationMs: null },
      { hour: '10', total: 1, success: 1, failed: 0, blocked: 0, medianDurationMs: 50 },
    ] });
    expect(r).toEqual([
      { hour: '08', total: 2, success: 2, failed: 0, blocked: 0, medianDurationMs: null },
      { hour: '10', total: 1, success: 1, failed: 0, blocked: 0, medianDurationMs: 50 },
    ]);
  });
});

describe('parseRecentErrors', () => {
  it('可选字段缺失保留 undefined', () => {
    const r = parseRecentErrors({ list: [{ kind: 'AUDIT', at: 't', type: 'x', resource: 'r' }] });
    expect(r[0].durationMs).toBeUndefined();
  });
  it('必填字段缺失剔除该行', () => {
    expect(parseRecentErrors({ list: [{ kind: 'AUDIT' }] })).toEqual([]);
  });
  it('list 缺失抛 ContractError', () => {
    expect(() => parseRecentErrors({})).toThrow(ContractError);
  });
});

describe('parseSlaMonthly', () => {
  it('正常响应解析', () => {
    expect(parseSlaMonthly(SLA_OK).availability).toBe(0.9995);
  });
  it('availability null（采样中）保持 null——不转 100%（口径红线）', () => {
    const r = parseSlaMonthly({ ...SLA_OK, availability: null });
    expect(r.availability).toBeNull();
  });
  it('basis 缺失抛错（口径可追溯性）', () => {
    expect(() => parseSlaMonthly({ ...SLA_OK, basis: null })).toThrow(ContractError);
  });
  it('incidents 非数组抛错', () => {
    expect(() => parseSlaMonthly({ ...SLA_OK, incidents: null })).toThrow(ContractError);
  });
});

describe('parseMaintenanceWindows', () => {
  it('snake_case 字段映射为 camelCase', () => {
    const r = parseMaintenanceWindows({ list: [{ id: 1, tenant_id: 0, title: '升级', start_at: 'a', end_at: 'b', status: 'DONE' }] });
    expect(r[0]).toMatchObject({ tenantId: 0, startAt: 'a', endAt: 'b' });
  });
  it('非法行剔除', () => {
    expect(parseMaintenanceWindows({ list: [{ id: 'x' }] })).toEqual([]);
  });
  it('list 缺失抛 ContractError', () => {
    expect(() => parseMaintenanceWindows({})).toThrow(ContractError);
  });
});

describe('parseYearMonth', () => {
  it('合法输入', () => {
    expect(parseYearMonth('2026-11')).toEqual({ year: 2026, month: 11 });
  });
  it('月份越界/格式错拒', () => {
    expect(parseYearMonth('2026-13')).toBeNull();
    expect(parseYearMonth('202611')).toBeNull();
    expect(parseYearMonth('abcd-ef')).toBeNull();
  });
});

describe('statusTag（未知值灰态不猜测）', () => {
  it('UP/DEGRADED/DOWN/未知 四色映射', () => {
    const cases: [string, string][] = [['UP', 'green'], ['DEGRADED', 'orange'], ['DOWN', 'red'], ['WEIRD', 'default']];
    for (const [v, expected] of cases) {
      const el = statusTag(v) as unknown as { props: { color: string; children: string } };
      expect(el.props.color).toBe(expected);
      expect(el.props.children).toBe(v);
    }
  });
});

// React 引用保持（statusTag 返回 JSX——测试文件引入 React 防止运行时报错）
void React;