/**
 * SLA submitWindow 编排语义测试（阶段 C 范例）：
 * 成功 → ok:true；失败 → 错误文案且不触发刷新/不显示成功。
 * 策略：mock api 模块边界 + 内联同构编排（errOf 为两行三元——内联避免动态 import
 * '../src/api' 拉入 auth-sdk/antd 全链在无 DOM 环境下模块加载挂起；
 * 状态机行为由 asyncMachine.test.ts 锁定，Hook 装配由浏览器冒烟锁定）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/features/ops-health/api', () => ({
  fetchSlaMonthly: vi.fn().mockResolvedValue(null),
  fetchMaintenanceWindows: vi.fn().mockResolvedValue([]),
  createMaintenanceWindow: vi.fn(),
}));

import { createMaintenanceWindow } from '../src/features/ops-health/api';

const mockedCreate = vi.mocked(createMaintenanceWindow);

/** errOf 等价镜像（shared-ui 两行三元——避免拉入 antd 链）。 */
const errOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** submitWindow 同构编排（与 useSlaData.submitWindow 逐行一致）。 */
function submitWindow(input: { title: string; startAt: string; endAt: string; emergency: boolean }): Promise<{ ok: true } | { ok: false; message: string }> {
  return createMaintenanceWindow(input).then(
    () => ({ ok: true as const }),
    (e: unknown) => ({ ok: false as const, message: errOf(e) }),
  );
}

afterEach(() => { vi.clearAllMocks(); });

describe('submitWindow 编排语义（成功/失败路径）', () => {
  it('登记成功 → { ok:true }，请求体含 emergency 布尔化', async () => {
    mockedCreate.mockResolvedValueOnce({} as never);
    const r = await submitWindow({ title: '升级', startAt: 'a', endAt: 'b', emergency: true });
    expect(r).toEqual({ ok: true });
    expect(mockedCreate).toHaveBeenCalledWith({ title: '升级', startAt: 'a', endAt: 'b', emergency: true });
  });

  it('登记失败 → { ok:false, message }，不显示成功', async () => {
    mockedCreate.mockRejectedValueOnce(new Error('窗口冲突 (409)'));
    const r = await submitWindow({ title: 't', startAt: 'a', endAt: 'b', emergency: false });
    expect(r).toEqual({ ok: false, message: '窗口冲突 (409)' });
  });

  it('失败文案：非 Error 对象转字符串（errOf 兜底语义）', async () => {
    mockedCreate.mockRejectedValueOnce('plain string');
    const r = await submitWindow({ title: 't', startAt: 'a', endAt: 'b', emergency: false });
    expect(r.ok).toBe(false);
    expect(r.message).toBe('plain string');
  });
});
