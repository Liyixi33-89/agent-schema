/**
 * 健康/SLA 接口适配层（阶段 C 重构范例——集中接口路径与参数；展示组件不自行请求）。
 * 复用既有 api.ts req 通道（auth-sdk authFetch + 401 刷新 + 403 判定），零安全边界改动。
 */
import { req } from '../../api';
import {
  parseCompile, parseHealthInfo, parseMaintenanceWindows, parseRecentErrors,
  parseSlaMonthly, parseTenantOverview, parseThroughput, parseYearMonth,
  type CompilePoint, type HealthInfo, type MaintenanceWindow,
  type RecentErrorItem, type SlaMonthly, type TenantHealthOverview, type ThroughputPoint,
} from './contracts';

/** 后端裸响应包装：约定层数据契约校验不过 → null（页面按「不可用」渲染，不编造统计值）。 */

export async function fetchHealthInfo(): Promise<HealthInfo | null> {
  return parseHealthInfo(await req('GET', '/api/ops/health'));
}
export async function fetchTenantOverview(): Promise<TenantHealthOverview | null> {
  return parseTenantOverview(await req('GET', '/api/ops/health/tenant/overview'));
}
export async function fetchThroughput(): Promise<ThroughputPoint[] | null> {
  return parseThroughput(await req('GET', '/api/ops/health/tenant/api-throughput'));
}
export async function fetchCompile(): Promise<CompilePoint[] | null> {
  return parseCompile(await req('GET', '/api/ops/health/tenant/script-compile'));
}
export async function fetchRecentErrors(): Promise<RecentErrorItem[] | null> {
  return parseErrorsResp(await req('GET', '/api/ops/health/tenant/recent-errors'));
}
function parseErrorsResp(raw: unknown): RecentErrorItem[] | null { return parseRecentErrors(raw); }

export async function fetchSlaMonthly(month: string): Promise<SlaMonthly | null> {
  const ym = parseYearMonth(month);
  if (!ym) return null;
  return parseSlaMonthly(await req('GET', `/api/ops/sla/monthly?year=${ym.year}&month=${ym.month}`));
}
export async function fetchMaintenanceWindows(): Promise<MaintenanceWindow[] | null> {
  return parseMaintenanceWindows(await req('GET', '/api/ops/sla/maintenance-windows'));
}
export function createMaintenanceWindow(input: {
  title: string; startAt: string; endAt: string; emergency: boolean;
}): Promise<unknown> {
  return req('POST', '/api/ops/sla/maintenance-windows', {
    title: input.title, startAt: input.startAt, endAt: input.endAt, emergency: input.emergency,
  });
}
