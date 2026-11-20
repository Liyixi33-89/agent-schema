/**
 * 健康页数据 Hook（阶段 C 范例——页面编排层只消费此 Hook，不直接发请求）：
 * - 五区域各自独立加载/竞态保护；overview 区域承载 403/错误引导（与既有行为一致）；
 * - 探活/时序/错误清单失败静默置 null（页面渲染「不可用」文案）——保持原有静默策略，
 *   但 overview 失败必须显式错误 + 重试（原行为保留）。
 */
import React from 'react';
import {
  fetchCompile, fetchHealthInfo, fetchRecentErrors, fetchThroughput, fetchTenantOverview,
} from './api';
import { useAsyncData, HEALTH_POLL_MS } from './useAsyncData';
import type { CompilePoint, HealthInfo, RecentErrorItem, TenantHealthOverview, ThroughputPoint } from './contracts';

export interface HealthData {
  basic: { data: HealthInfo | null; loading: boolean };
  overview: { data: TenantHealthOverview | null; loading: boolean; error: string | null; forbidden: boolean; stale: boolean; reload: () => void };
  throughput: { data: ThroughputPoint[] | null; loading: boolean };
  compile: { data: CompilePoint[] | null; loading: boolean };
  recentErrors: { data: RecentErrorItem[] | null; loading: boolean };
}

export function useHealthData(): HealthData {
  const basic = useAsyncData(fetchHealthInfo, [], HEALTH_POLL_MS);
  const overview = useAsyncData(fetchTenantOverview, [], HEALTH_POLL_MS);
  const throughput = useAsyncData(fetchThroughput, [], HEALTH_POLL_MS);
  const compile = useAsyncData(fetchCompile, [], HEALTH_POLL_MS);
  const recentErrors = useAsyncData(fetchRecentErrors, [], HEALTH_POLL_MS);
  return {
    basic: { data: basic.data, loading: basic.loading },
    overview: { data: overview.data, loading: overview.loading, error: overview.error, forbidden: overview.forbidden, stale: overview.stale, reload: overview.reload },
    throughput: { data: throughput.data, loading: throughput.loading },
    compile: { data: compile.data, loading: compile.loading },
    recentErrors: { data: recentErrors.data, loading: recentErrors.loading },
  };
}
