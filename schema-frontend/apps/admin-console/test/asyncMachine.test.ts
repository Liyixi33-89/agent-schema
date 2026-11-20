/**
 * 异步状态机测试（阶段 C 范例核心——状态迁移纯函数全行为锁定）：
 * 覆盖：初次 loading→成功/失败、403 与网络错误区分（按状态码）、重试成功清错误、
 *       刷新失败保留旧数据并标 stale、刷新中 refreshing、查询身份变化 reset、
 *       403 非粘性恢复、竞态闸门（旧响应/卸载丢弃）、取消不迁移状态。
 */
import { describe, expect, it } from 'vitest';
import {
  ASYNC_INIT, begin, fail, isAbortError, reset, shouldAccept, succeed,
} from '../src/shared/async/asyncMachine';
import { ApiError } from '../src/api';
import { HEALTH_POLL_MS } from '../src/shared/async/useAsyncData';

describe('reset（查询身份变化）', () => {
  it('完全重置：清数据/错误/权限/过期', () => {
    expect(reset()).toEqual({
      loading: true, refreshing: false, data: null, error: null, forbidden: false, stale: false,
    });
  });
});

describe('begin（请求发起迁移）', () => {
  it('初次：loading=true、refreshing=false', () => {
    const s = begin({ ...ASYNC_INIT, loading: false, data: null });
    expect(s.loading).toBe(true);
    expect(s.refreshing).toBe(false);
  });
  it('已有数据刷新：不遮罩（loading=false）、标 refreshing、清 stale', () => {
    const s = begin({ loading: false, refreshing: false, data: { v: 1 }, error: '旧错误', forbidden: false, stale: true });
    expect(s.loading).toBe(false);
    expect(s.refreshing).toBe(true);
    expect(s.stale).toBe(false);
    expect(s.data).toEqual({ v: 1 });
  });
});

describe('succeed（成功迁移）', () => {
  it('落数据清全部错误/刷新标记', () => {
    const s = succeed({ loading: true, refreshing: true, data: null, error: 'x', forbidden: true, stale: true }, { v: 2 });
    expect(s).toEqual({ loading: false, refreshing: false, data: { v: 2 }, error: null, forbidden: false, stale: false });
  });
  it('空数组是合法无样本（不是错误）', () => {
    const s = succeed({ ...ASYNC_INIT, loading: true }, []);
    expect(s.data).toEqual([]);
    expect(s.error).toBeNull();
  });
});

describe('fail（失败迁移）', () => {
  it('网络错误：error 文案、初次失败无 stale', () => {
    const s = fail({ ...ASYNC_INIT, loading: true }, new Error('网络中断'));
    expect(s).toEqual({ loading: false, refreshing: false, data: null, error: '网络中断', forbidden: false, stale: false });
  });
  it('403（ApiError 状态码）：forbidden=true、error 置空', () => {
    const s = fail({ ...ASYNC_INIT, loading: true }, new ApiError('无权限', 403));
    expect(s.forbidden).toBe(true);
    expect(s.error).toBeNull();
  });
  it('业务文案不含 403 但状态码 403 → 仍判无权限（不靠文案）', () => {
    const s = fail({ ...ASYNC_INIT, loading: true }, new ApiError('您没有该资源的访问权限', 403));
    expect(s.forbidden).toBe(true);
  });
  it('文案含 403 但状态码非 403 → 不判无权限（不靠文案）', () => {
    const s = fail({ ...ASYNC_INIT, loading: true }, new ApiError('请求失败 (500) 403 相关', 500));
    expect(s.forbidden).toBe(false);
    expect(s.error).toBe('请求失败 (500) 403 相关');
  });
  it('刷新失败：旧数据保留 + stale=true（不当最新）', () => {
    const s = fail({ loading: false, refreshing: true, data: { v: 1 }, error: null, forbidden: false, stale: false }, new Error('刷新失败'));
    expect(s.data).toEqual({ v: 1 });
    expect(s.stale).toBe(true);
    expect(s.refreshing).toBe(false);
    expect(s.error).toBe('刷新失败');
  });
  it('刷新时 403：保留旧数据但 stale 不标记（权限引导优先）', () => {
    const s = fail({ loading: false, refreshing: true, data: { v: 1 }, error: null, forbidden: false, stale: false }, new ApiError('无权限', 403));
    expect(s.forbidden).toBe(true);
    expect(s.stale).toBe(false);
  });
  it('forbidden 非粘性：403 之后的普通失败清除 forbidden（按普通错误展示）', () => {
    const first = fail({ ...ASYNC_INIT, loading: true }, new ApiError('无权限', 403));
    const second = fail(first, new Error('网络中断'));
    expect(second.forbidden).toBe(false);
    expect(second.error).toBe('网络中断');
  });
});

describe('isAbortError（取消不迁移状态）', () => {
  it('AbortError 识别', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    expect(isAbortError(e)).toBe(true);
  });
  it('普通错误不是取消', () => {
    expect(isAbortError(new Error('x'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
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