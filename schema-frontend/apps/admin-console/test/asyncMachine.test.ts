/**
 * 异步状态机测试（阶段 C 范例核心——状态迁移纯函数全行为锁定）：
 * 覆盖：初次 loading→成功/失败、403 与网络错误区分、重试成功清错误、
 *       刷新失败保留旧数据并标 stale、竞态闸门（旧响应/卸载丢弃）、空样本合法性。
 */
import { describe, expect, it } from 'vitest';
import { ASYNC_INIT, begin, fail, shouldAccept, succeed } from '../src/features/ops-health/asyncMachine';
import { HEALTH_POLL_MS } from '../src/features/ops-health/useAsyncData';

describe('begin（请求发起迁移）', () => {
  it('初次：loading=true', () => {
    expect(begin({ ...ASYNC_INIT, loading: false, data: null })).toMatchObject({ loading: true });
  });
  it('已有数据刷新：不遮罩（loading 保持 false）、清 stale', () => {
    const s = begin({ loading: false, data: { v: 1 }, error: '旧错误', forbidden: false, stale: true });
    expect(s.loading).toBe(false);
    expect(s.stale).toBe(false);
    expect(s.data).toEqual({ v: 1 });
  });
});

describe('succeed（成功迁移）', () => {
  it('落数据清全部错误标记', () => {
    const s = succeed({ loading: true, data: null, error: 'x', forbidden: true, stale: true }, { v: 2 });
    expect(s).toEqual({ loading: false, data: { v: 2 }, error: null, forbidden: false, stale: false });
  });
  it('null 数据合法（契约不过≠error——页面按不可用渲染）', () => {
    const s = succeed({ ...ASYNC_INIT, loading: true }, null);
    expect(s.data).toBeNull();
    expect(s.error).toBeNull();
  });
});

describe('fail（失败迁移）', () => {
  it('网络错误：error 文案、初次失败无 stale（无旧数据可留）', () => {
    const s = fail({ ...ASYNC_INIT, loading: true }, new Error('网络中断'));
    expect(s).toEqual({ loading: false, data: null, error: '网络中断', forbidden: false, stale: false });
  });
  it('403：forbidden=true、error 置空（页面走权限引导不走重试）', () => {
    const s = fail({ ...ASYNC_INIT, loading: true }, new Error('请求失败 (403)'));
    expect(s.forbidden).toBe(true);
    expect(s.error).toBeNull();
  });
  it('刷新失败：旧数据保留 + stale=true（不当最新）', () => {
    const s = fail({ loading: false, data: { v: 1 }, error: null, forbidden: false, stale: false }, new Error('刷新失败'));
    expect(s.data).toEqual({ v: 1 });
    expect(s.stale).toBe(true);
    expect(s.error).toBe('刷新失败');
  });
  it('刷新时 403：保留旧数据但 stale 不标记（权限引导优先）', () => {
    const s = fail({ loading: false, data: { v: 1 }, error: null, forbidden: false, stale: false }, new Error('请求失败 (403)'));
    expect(s.forbidden).toBe(true);
    expect(s.stale).toBe(false);
  });
  it('forbidden 粘性（一旦 403 不被后续网络失败清除）', () => {
    const first = fail({ ...ASYNC_INIT, loading: true }, new Error('请求失败 (403)'));
    const second = fail(first, new Error('网络中断'));
    expect(second.forbidden).toBe(true);
    expect(second.error).toBe('网络中断');
  });
});

describe('shouldAccept（竞态与卸载闸门）', () => {
  it('最新序号 + 存活 → 接受', () => {
    expect(shouldAccept(3, 3, true)).toBe(true);
  });
  it('旧请求晚回（序号落后）→ 丢弃', () => {
    expect(shouldAccept(5, 3, true)).toBe(false);
  });
  it('已卸载（alive=false）→ 丢弃（即使序号最新）', () => {
    expect(shouldAccept(3, 3, false)).toBe(false);
  });
});

describe('常量基线（既有行为锚定）', () => {
  it('健康页轮询 30s', () => {
    expect(HEALTH_POLL_MS).toBe(30000);
  });
});
