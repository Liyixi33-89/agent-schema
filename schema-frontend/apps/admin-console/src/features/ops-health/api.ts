/**
 * 健康/SLA 接口适配层（feature 内聚——集中接口路径与参数；展示组件不自行请求）。
 * 复用既有 api.ts req 通道（auth-sdk authFetch + 401 刷新 + 403 判定），零安全边界改动。
 * 契约校验失败抛 ContractError（进入明确错误态）；合法无样本返回空数组。
 */
import { req } from '../../api';
import {
  ContractError, parseCompile, parseHealthInfo, parseMaintenanceWindows, parseRecentErrors,
  parseSlaMonthly, parseTenantOverview, parseThroughput, parseYearMonth,
  type CompilePoint, type HealthInfo, type MaintenanceWindow,
  type RecentErrorItem, type SlaMonthly, type TenantHealthOverview, type ThroughputPoint,
} from '../../shared/contracts';

export async function fetchHealthInfo(signal?: AbortSignal): Promise<HealthInfo> {
  return parseHealthInfo(await req('GET', '/api/ops/health', undefined, signal));
}
export async function fetchTenantOverview(signal?: AbortSignal): Promise<TenantHealthOverview> {
  return parseTenantOverview(await req('GET', '/api/ops/health/tenant/overview', undefined, signal));
}
export async function fetchThroughput(signal?: AbortSignal): Promise<ThroughputPoint[]> {
  return parseThroughput(await req('GET', '/api/ops/health/tenant/api-throughput', undefined, signal));
}
export async function fetchCompile(signal?: AbortSignal): Promise<CompilePoint[]> {
  return parseCompile(await req('GET', '/api/ops/health/tenant/script-compile', undefined, signal));
}
export async function fetchRecentErrors(signal?: AbortSignal): Promise<RecentErrorItem[]> {
  return parseRecentErrors(await req('GET', '/api/ops/health/tenant/recent-errors', undefined, signal));
}

export async function fetchSlaMonthly(month: string, signal?: AbortSignal): Promise<SlaMonthly> {
  const ym = parseYearMonth(month);
  if (!ym) throw new ContractError('/api/ops/sla/monthly', `非法月份参数 ${month}`);
  return parseSlaMonthly(
    await req('GET', `/api/ops/sla/monthly?year=${ym.year}&month=${ym.month}`, undefined, signal),
  );
}
export async function fetchMaintenanceWindows(signal?: AbortSignal): Promise<MaintenanceWindow[]> {
  return parseMaintenanceWindows(await req('GET', '/api/ops/sla/maintenance-windows', undefined, signal));
}
export function createMaintenanceWindow(input: {
  title: string; startAt: string; endAt: string; emergency: boolean;
}): Promise<unknown> {
  return req('POST', '/api/ops/sla/maintenance-windows', {
    title: input.title, startAt: input.startAt, endAt: input.endAt, emergency: input.emergency,
  });
}