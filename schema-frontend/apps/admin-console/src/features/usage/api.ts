/**
 * 租户用量 feature（09BE /api/metering/usage/summary）——API 适配层。
 * 契约校验失败抛 ContractError（进入明确错误态），不返回 null 冒充空数据。
 */
import { req } from '../../api';
import { ContractError } from '../../shared/contracts';

export interface UsageMetric { metric: string; today?: number; total?: number }
export interface UsageSummary {
  licensedSeats: number;
  activeSeats: number;
  metrics: UsageMetric[];
}

function optNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function parseUsageSummary(raw: unknown): UsageSummary {
  if (typeof raw !== 'object' || raw === null) throw new ContractError('/api/metering/usage/summary', '响应不是对象');
  const o = raw as Record<string, unknown>;
  const licensedSeats = optNum(o.licensedSeats);
  const activeSeats = optNum(o.activeSeats);
  if (licensedSeats === undefined || activeSeats === undefined) {
    throw new ContractError('/api/metering/usage/summary', 'licensedSeats/activeSeats 缺失或类型不符');
  }
  const metrics: UsageMetric[] = [];
  if (Array.isArray(o.metrics)) {
    for (const m of o.metrics) {
      if (typeof m !== 'object' || m === null) continue;
      const mo = m as Record<string, unknown>;
      if (typeof mo.metric !== 'string') continue;
      metrics.push({ metric: mo.metric, today: optNum(mo.today), total: optNum(mo.total) });
    }
  }
  return { licensedSeats, activeSeats, metrics };
}

export async function fetchUsageSummary(signal?: AbortSignal): Promise<UsageSummary> {
  return parseUsageSummary(await req('GET', '/api/metering/usage/summary', undefined, signal));
}