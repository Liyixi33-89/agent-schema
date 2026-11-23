/**
 * 维护窗口登记编排测试（第三阶段：单测优先直接执行生产代码）。
 *
 * 覆盖：成功 → ok:true 且触发刷新；失败 → 错误文案且不触发刷新；
 *       入参原样透传（不被改写）；errOf 归一语义；失败不产生副作用。
 *
 * 策略：直接 import 生产函数 submitMaintenanceWindow，
 * 通过参数注入 create/reload/errOf spy —— 不复制任何编排逻辑。
 * （旧版在用例里内联「同构逻辑」，生产改错时测试仍绿。）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitMaintenanceWindow } from '../src/features/ops-health/submitWindow';

/** errOf 生产实现（与 shared-ui 同源：Error 取 message，否则 String）。
 *  此处内联仅为避免拉入 antd 依赖链；errOf 自身行为由 shared-ui 保证。 */
const errOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const INPUT = { title: '升级', startAt: '2026-12-01T02:00:00Z', endAt: '2026-12-01T03:00:00Z', emergency: true };

afterEach(() => { vi.clearAllMocks(); });

describe('submitMaintenanceWindow（生产代码）· 成功路径', () => {
  it('成功后触发刷新并返回 ok:true', async () => {
    const create = vi.fn().mockResolvedValue({ id: 1 });
    const reload = vi.fn();
    const r = await submitMaintenanceWindow(INPUT, create, reload, errOf);
    expect(r).toEqual({ ok: true });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('入参原样透传给 create（含 emergency 布尔，不改写）', async () => {
    const create = vi.fn().mockResolvedValue({});
    await submitMaintenanceWindow(INPUT, create, vi.fn(), errOf);
    expect(create).toHaveBeenCalledWith(INPUT);
    expect(vi.mocked(create).mock.calls[0][0].emergency).toBe(true);
  });

  it('刷新在 create 成功之后才发生（顺序保证）', async () => {
    const order: string[] = [];
    const create = vi.fn(async () => { order.push('create'); return {}; });
    const reload = vi.fn(() => { order.push('reload'); });
    await submitMaintenanceWindow(INPUT, create, reload, errOf);
    expect(order).toEqual(['create', 'reload']);
  });
});

describe('submitMaintenanceWindow（生产代码）· 失败路径', () => {
  it('create 抛错 → 返回错误文案且不刷新', async () => {
    const create = vi.fn().mockRejectedValue(new Error('窗口冲突 (409)'));
    const reload = vi.fn();
    const r = await submitMaintenanceWindow(INPUT, create, reload, errOf);
    expect(r).toEqual({ ok: false, message: '窗口冲突 (409)' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('非 Error 对象 → errOf 兜底转字符串', async () => {
    const create = vi.fn().mockRejectedValue('plain string');
    const r = await submitMaintenanceWindow(INPUT, create, vi.fn(), errOf);
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toBe('plain string');
  });

  it('不吞异常类型：ApiError 的 message 原样透出', async () => {
    const create = vi.fn().mockRejectedValue(new Error('您没有该资源的访问权限'));
    const r = await submitMaintenanceWindow(INPUT, create, vi.fn(), errOf);
    expect((r as { message: string }).message).toBe('您没有该资源的访问权限');
  });

  it('失败时不返回 ok:true（不产生假成功）', async () => {
    const create = vi.fn().mockRejectedValue(new Error('x'));
    const r = await submitMaintenanceWindow(INPUT, create, vi.fn(), errOf);
    expect('ok' in r && r.ok === true).toBe(false);
  });
});