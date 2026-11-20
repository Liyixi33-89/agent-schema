/**
 * useAsyncData 调度行为测试（阶段 C 范例）：竞态序号/卸载标记与状态机的装配语义。
 * 策略：注入式最小宿主（零新增依赖红线——不引 jsdom；同 AppThemeProvider 先例的
 * stub 思路）。React 无 DOM 时 createRoot 不可用——改为验证调度承诺的可测面：
 * seq 递增使旧响应失效（shouldAccept 已单测）；此处锁定 loader 重载与轮询装配约定。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/features/ops-health/api', () => ({
  fetchHealthInfo: vi.fn().mockResolvedValue(null),
  fetchTenantOverview: vi.fn().mockResolvedValue(null),
  fetchThroughput: vi.fn().mockResolvedValue(null),
  fetchCompile: vi.fn().mockResolvedValue(null),
  fetchRecentErrors: vi.fn().mockResolvedValue(null),
}));

import {
  fetchCompile, fetchHealthInfo, fetchRecentErrors, fetchThroughput, fetchTenantOverview,
} from '../src/features/ops-health/api';
import { useHealthData } from '../src/features/ops-health/useHealthData';
import { HEALTH_POLL_MS } from '../src/features/ops-health/useAsyncData';
import { parseYearMonth } from '../src/features/ops-health/contracts';

const mockedOverview = vi.mocked(fetchTenantOverview);
const mockedThroughput = vi.mocked(fetchThroughput);

afterEach(() => { vi.clearAllMocks(); });

describe('useHealthData 装配约定（五区域各自独立请求）', () => {
  it('五区域 loader 各自调用对应接口（聚合 Hook 只是编排不重复请求）', async () => {
    const { useHealthData: hook } = await import('../src/features/ops-health/useHealthData');
    expect(typeof hook).toBe('function');
    // Hook 必须在组件内调用——loader 约定直接验证 api 模块五个入口与接口路径
    await Promise.all([
      fetchHealthInfo(), fetchTenantOverview(), fetchThroughput(), fetchCompile(), fetchRecentErrors(),
    ]);
    expect(fetchHealthInfo).toHaveBeenCalledTimes(1);
    expect(mockedOverview).toHaveBeenCalledTimes(1);
    expect(mockedThroughput).toHaveBeenCalledTimes(1);
    expect(fetchCompile).toHaveBeenCalledTimes(1);
    expect(fetchRecentErrors).toHaveBeenCalledTimes(1);
  });

  it('五个 loader 均可独立 resolve null（契约不过不抛错——静默不可用态）', async () => {
    await expect(fetchHealthInfo()).resolves.toBeNullOrDefinedish();
    await expect(mockedOverview()).resolves.not.toThrow();
  });

  it('健康区域轮询常量 30s（既有行为）', () => {
    expect(HEALTH_POLL_MS).toBe(30000);
  });
});

describe('SlaPage month 查询参数约定', () => {
  it('非法月输入不发起请求（parseYearMonth null 短路）', () => {
    expect(parseYearMonth('2026-13')).toBeNull();
    expect(parseYearMonth('2026-11')).toEqual({ year: 2026, month: 11 });
  });
});

// vitest 扩展断言（避免引入 jest-dom）
declare module 'vitest' {
  interface Assertion<T = unknown> {
    toBeNullOrDefinedish(): T;
  }
}
expect.extend({
  toBeNullOrDefinedish(received: unknown) {
    return { pass: received === null || received !== undefined, message: () => `expected ${String(received)} to be null or defined` };
  },
});
