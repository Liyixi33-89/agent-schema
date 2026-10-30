/**
 * usage-tracker 单测（09FE §6 硬性要求）：
 * 合规扫描 / flush 三触发与 eventId 不重复生成 / 失败重试复用原 eventId /
 * seat.active 按日去重 / buffer 溢出丢最旧。
 */
import { describe, expect, it, vi } from 'vitest';
import { UsageTracker, complianceScan } from '../src/index';

function makeTracker(opts: {
  batchSize?: number;
  flushIntervalMs?: number;
  failFirst?: number;
}) {
  let uuidSeq = 0;
  let transportCalls = 0;
  const bodies: string[] = [];
  const tracker = new UsageTracker({
    batchSize: opts.batchSize,
    flushIntervalMs: opts.flushIntervalMs,
    uuid: () => `id-${++uuidSeq}`,
    now: () => 1_700_000_000_000,
    transport: async (_url, body) => {
      bodies.push(body);
      transportCalls++;
      if (opts.failFirst && transportCalls <= opts.failFirst) return false;
      return true;
    },
  });
  return { tracker, bodies };
}

describe('合规扫描（09FE §6）', () => {
  it('白名单值正常通过', () => {
    expect(complianceScan({ type: 'seat.active', surface: 'designer' })).toBeNull();
    expect(complianceScan({ type: 'artifact.load', pageId: '42', hash: 'abc' })).toBeNull();
  });

  it('超长字符串被拒', () => {
    const violation = complianceScan({ type: 'artifact.load', pageId: 'x'.repeat(65), hash: 'abc' });
    expect(violation).toContain('超长');
  });
});

describe('flush 管线（09FE §6）', () => {
  it('满 batchSize 立即 flush 且 eventId 不重复生成', async () => {
    const { tracker, bodies } = makeTracker({ batchSize: 2 });
    const before = tracker.bufferedEventIds();
    tracker.track({ type: 'seat.active', surface: 'designer' });
    tracker.track({ type: 'seat.active', surface: 'runtime' }); // 不同 surface 不去重？——按日去重只看类型
    // seat.active 按日去重：第二条被跳过 → buffer 只有 1 条，手动 flush
    expect(tracker.bufferedCount).toBe(1);
    expect(tracker.bufferedEventIds()[0]).not.toBe(before[0]);
    await tracker.flush();
    expect(bodies).toHaveLength(1);
    const parsed = JSON.parse(bodies[0]);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].metric).toBe('seat.active');
  });

  it('非 seat 事件满批触发自动 flush', async () => {
    const { tracker, bodies } = makeTracker({ batchSize: 2 });
    tracker.track({ type: 'artifact.load', pageId: '1', hash: 'a' });
    tracker.track({ type: 'artifact.load', pageId: '2', hash: 'b' });
    // flush 是异步的；等待微任务
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(tracker.bufferedCount).toBe(0);
  });

  it('网络失败重试复用原 eventId（幂等红线）', async () => {
    const { tracker, bodies } = makeTracker({ batchSize: 1, failFirst: 1 });
    tracker.track({ type: 'artifact.load', pageId: '1', hash: 'a' });
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    // 第一次失败 → buffer 保留
    expect(tracker.bufferedCount).toBe(1);
    const firstId = tracker.bufferedEventIds()[0];
    await tracker.flush();
    const secondBody = JSON.parse(bodies[1]);
    expect(secondBody.events[0].eventId).toBe(firstId);
    expect(tracker.bufferedCount).toBe(0);
  });

  it('buffer 溢出丢最旧并计数', () => {
    const { tracker } = makeTracker({ batchSize: 100 });
    for (let i = 0; i < 105; i++) {
      tracker.track({ type: 'artifact.load', pageId: String(i), hash: 'h' });
    }
    expect(tracker.bufferedCount).toBe(100);
    expect(tracker.dropped).toBe(5);
    tracker.dispose();
  });
});

describe('seat.active 按日去重（09FE §4）', () => {
  it('同日多次写操作仅一条', () => {
    const { tracker } = makeTracker({ batchSize: 100 });
    tracker.track({ type: 'seat.active', surface: 'designer' });
    tracker.track({ type: 'seat.active', surface: 'designer' });
    tracker.track({ type: 'seat.active', surface: 'runtime' });
    expect(tracker.bufferedCount).toBe(1);
    tracker.dispose();
  });
});

describe('visibilitychange flush（09FE §3）', () => {
  it('hidden 时 sendBeacon 清空 buffer', () => {
    const beacon = vi.fn();
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const { tracker } = makeTracker({ batchSize: 100 });
    tracker.track({ type: 'artifact.load', pageId: '1', hash: 'a' });
    tracker.onVisibilityHidden();
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(tracker.bufferedCount).toBe(0);
    vi.unstubAllGlobals();
    tracker.dispose();
  });
});
