/**
 * 图表装载状态机单测（spec 018 T4）：取消 / 竞态 / 重试隔离 / 响应契约。
 * 纯逻辑断言——不渲染组件（宿主接线由 DashboardPageHost 消费本模块保证同语义）。
 */
import { describe, expect, it, vi } from 'vitest';
import { ChartLoadCoordinator, aggBody, errorOf, type ChartState } from './chartLoad';
import type { ChartDs } from '@schema/chart-kit';

const ds: ChartDs = {
  modelId: 'm1',
  aggregate: { measures: [{ fieldKey: 'amount', func: 'SUM' }], group: { fieldKey: 'type' } },
};

/** 受控聚合桩：按调用顺序返回 deferred，测试手动 resolve/reject 模拟竞态。 */
function harness() {
  const calls: { modelId: string; body: Record<string, unknown>; signal?: AbortSignal;
    resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  const aggregate = vi.fn((modelId: string, body: Record<string, unknown>, options?: { signal?: AbortSignal }) =>
    new Promise<unknown>((resolve, reject) => {
      calls.push({ modelId, body, signal: options?.signal, resolve, reject });
    }));
  const states = new Map<string, ChartState[]>();
  const setNode = (nodeId: string, state: ChartState) => {
    const list = states.get(nodeId) ?? [];
    list.push(state);
    states.set(nodeId, list);
  };
  const last = (nodeId: string): ChartState | undefined => states.get(nodeId)?.at(-1);
  return { aggregate, calls, setNode, last, log: states };
}

const rows = [{ dimension: 'A', values: [{ func: 'SUM', fieldKey: 'amount', value: 1 }] }];

describe('aggBody 请求体映射（冻结 AggregateRequest → parseRequest 字段名）', () => {
  it('measures/group/filter 全透传，timeBucket 映射 bucketField/bucketInterval', () => {
    const full: ChartDs = {
      modelId: 'm2',
      aggregate: {
        measures: [{ fieldKey: 'amount', func: 'SUM' }],
        group: { fieldKey: 'type', topN: 20 },
        timeBucket: { fieldKey: 'created', interval: 'DAY' },
      },
      filter: { and: [] },
    };
    expect(aggBody(full)).toEqual({
      filter: { and: [] },
      measures: [{ fieldKey: 'amount', func: 'SUM' }],
      groupField: 'type', groupTopN: 20,
      bucketField: 'created', bucketInterval: 'DAY',
    });
  });
});

describe('errorOf 错误归一', () => {
  it('AbortError → null（取消不进错误态）', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(errorOf(abort)).toBeNull();
  });
  it('ServerError 形态 → code: message；普通错误取 message', () => {
    expect(errorOf({ code: 'AGG_INVALID', message: '聚合字段不可用' })).toBe('AGG_INVALID: 聚合字段不可用');
    expect(errorOf(new Error('网络中断'))).toBe('网络中断');
    expect(errorOf('裸字符串')).toBe('裸字符串');
  });
});

describe('ChartLoadCoordinator 装载/取消/竞态', () => {
  it('整轮装载：全部节点 loading → 逐一 done', async () => {
    const h = harness();
    const c = new ChartLoadCoordinator(h.aggregate as never);
    c.begin([{ id: 'n1', ds }, { id: 'n2', ds }], h.setNode);
    expect(h.last('n1')?.phase).toBe('loading');
    h.calls[0].resolve({ rows });
    h.calls[1].resolve({ rows: [] });
    await Promise.resolve();
    expect(h.last('n1')).toEqual({ phase: 'done', rows });
    expect(h.last('n2')).toEqual({ phase: 'done', rows: [] });
    c.dispose();
  });

  it('页面切换 abort 在途请求：旧响应不写入新世代 state（spec 018 A2）', async () => {
    const h = harness();
    const c = new ChartLoadCoordinator(h.aggregate as never);
    c.begin([{ id: 'n1', ds }], h.setNode);
    const stale = h.calls[0];
    // 页面切换：新世代（旧请求未返回）
    c.begin([{ id: 'n1', ds }], h.setNode);
    expect(stale.signal?.aborted).toBe(true);
    // 旧响应晚到——世代号已递增，静默丢弃
    stale.resolve({ rows });
    await Promise.resolve();
    const seq = h.log.get('n1')!;
    expect(seq).toHaveLength(2);
    expect(seq[1].phase).toBe('loading'); // 旧响应未覆盖新世代的 loading
    // 新请求正常完成
    h.calls[1].resolve({ rows });
    await Promise.resolve();
    expect(h.last('n1')).toEqual({ phase: 'done', rows });
    c.dispose();
  });

  it('卸载 dispose：abort 全部在途请求且后续 retry 静默拒绝', async () => {
    const h = harness();
    const c = new ChartLoadCoordinator(h.aggregate as never);
    c.begin([{ id: 'n1', ds }], h.setNode);
    expect(h.calls[0].signal?.aborted).toBe(false);
    c.dispose();
    expect(h.calls[0].signal?.aborted).toBe(true);
    const before = h.aggregate.mock.calls.length;
    c.retry('n1', ds, h.setNode);
    expect(h.aggregate.mock.calls.length).toBe(before); // disposed 后不再发请求
    // abort 后响应晚到不落 state
    h.calls[0].resolve({ rows });
    await Promise.resolve();
    expect(h.last('n1')?.phase).toBe('loading'); // 无 error / done 写入
  });

  it('响应缺 rows（契约漂移）→ 错误态而非静默', async () => {
    const h = harness();
    const c = new ChartLoadCoordinator(h.aggregate as never);
    c.begin([{ id: 'n1', ds }], h.setNode);
    h.calls[0].resolve({ data: '漂移形态' });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.last('n1')).toMatchObject({ phase: 'error', message: '聚合响应缺少 rows' });
    c.dispose();
  });
});

describe('ChartLoadCoordinator 节点重试（spec 018 A3）', () => {
  it('失败 → 重试成功恢复 done；其他节点状态不受影响', async () => {
    const h = harness();
    const c = new ChartLoadCoordinator(h.aggregate as never);
    c.begin([{ id: 'bad', ds }, { id: 'good', ds }], h.setNode);
    h.calls[0].reject({ code: 'AGG_INVALID', message: '聚合字段不可用' });
    h.calls[1].resolve({ rows });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.last('bad')).toMatchObject({ phase: 'error', message: 'AGG_INVALID: 聚合字段不可用' });
    expect(h.last('good')).toEqual({ phase: 'done', rows });
    const goodSeq = h.log.get('good')!.length;

    c.retry('bad', ds, h.setNode);
    expect(h.last('bad')?.phase).toBe('loading');
    expect(h.log.get('good')!.length).toBe(goodSeq); // good 节点零重放
    h.calls[2].resolve({ rows });
    await Promise.resolve();
    expect(h.last('bad')).toEqual({ phase: 'done', rows });
    c.dispose();
  });

  it('连续重试：前次在途请求被 abort，旧响应不覆盖新重试结果', async () => {
    const h = harness();
    const c = new ChartLoadCoordinator(h.aggregate as never);
    c.begin([{ id: 'n1', ds }], h.setNode);
    h.calls[0].reject(new Error('第一次失败'));
    await Promise.resolve();
    await Promise.resolve();

    c.retry('n1', ds, h.setNode);
    const first = h.calls[1];
    c.retry('n1', ds, h.setNode); // 连续重试——abort 第一次重试
    expect(first.signal?.aborted).toBe(true);
    first.resolve({ rows }); // 被取消的旧响应晚到
    h.calls[2].resolve({ rows: [...rows, { dimension: 'B', values: [{ func: 'SUM', fieldKey: 'amount', value: 2 }] }] });
    await Promise.resolve();
    expect(h.last('n1')).toEqual({ phase: 'done', rows: [...rows, { dimension: 'B', values: [{ func: 'SUM', fieldKey: 'amount', value: 2 }] }] });
    c.dispose();
  });
});
