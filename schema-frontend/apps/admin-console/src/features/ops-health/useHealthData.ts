/**
 * 健康页数据 Hook（阶段 C 范例——页面编排层只消费此 Hook，不直接发请求）：
 * - 五区域各自独立加载/竞态保护/取消；
 * - **每个区域都暴露完整状态**（loading/refreshing/error/forbidden/stale/reload）——
 *   不能因为 overview 成功就把其他区域的失败隐藏起来；
 * - 403 由各区域自行上报，页面按区域展示权限引导（overview 仍承载整页引导）。
 */
import {
  fetchCompile, fetchHealthInfo, fetchRecentErrors, fetchThroughput, fetchTenantOverview,
} from './api';
import { useAsyncData, HEALTH_POLL_MS } from '../../shared/async';
import type { CompilePoint, HealthInfo, RecentErrorItem, TenantHealthOverview, ThroughputPoint } from '../../shared/contracts';
import type { AsyncState } from '../../shared/async';

/** 区域状态（数据 + 完整异步状态 + 重试）。 */
export type Region<T> = AsyncState<T> & { reload: () => void };

export interface HealthData {
  basic: Region<HealthInfo>;
  overview: Region<TenantHealthOverview>;
  throughput: Region<ThroughputPoint[]>;
  compile: Region<CompilePoint[]>;
  recentErrors: Region<RecentErrorItem[]>;
}

export function useHealthData(): HealthData {
  const basic = useAsyncData(fetchHealthInfo, [], HEALTH_POLL_MS);
  const overview = useAsyncData(fetchTenantOverview, [], HEALTH_POLL_MS);
  const throughput = useAsyncData(fetchThroughput, [], HEALTH_POLL_MS);
  const compile = useAsyncData(fetchCompile, [], HEALTH_POLL_MS);
  const recentErrors = useAsyncData(fetchRecentErrors, [], HEALTH_POLL_MS);
  return { basic, overview, throughput, compile, recentErrors };
}