/**
 * ScriptHost 执行器测试（08FE §8）：超时真终止、异常不白屏、池回收、消息桥白名单拒收。
 * WorkerLike 以受控假 Worker 模拟——terminate 行为按真实 worker 语义（终止后不再派发消息）。
 */
import { describe, expect, it, vi } from 'vitest';
import { ScriptHost, createMockBridge, createWorkerCtx } from '../src/script-host';
import type { WorkerLike, MessageBridge } from '../src/script-host';
import type { HookModule, ScriptBinding } from '../src/types';

class FakeWorker implements WorkerLike {
  terminated = false;
  private listener: ((e: { data: unknown }) => void) | null = null;
  constructor(private readonly mod: HookModule, private readonly hooks: Set<string>, private readonly silent = false) {}
  postMessage(message: unknown): void {
    if (this.terminated || this.silent) return; // 静默模式：收到 run 不回复（模拟死循环对协议的表现）
    const msg = message as { type: string; hook: string; payload: unknown };
    if (msg.type !== 'run') return;
    setTimeout(async () => {
      if (this.terminated) return; // 终止后消息不再派发——真实 worker 语义
      const fn = this.mod[msg.hook];
      if (typeof fn !== 'function' || !this.hooks.has(msg.hook)) {
        this.listener?.({ data: { type: 'hook-done', ok: false, err: `钩子不存在: ${msg.hook}` } });
        return;
      }
      try {
        const value = await (fn as (payload: unknown) => unknown)(msg.payload);
        this.listener?.({ data: { type: 'hook-done', ok: true, value } });
      } catch (e) {
        this.listener?.({ data: { type: 'hook-done', ok: false, err: e instanceof Error ? e.message : String(e) } });
      }
    }, 0);
  }
  terminate(): void { this.terminated = true; }
  addEventListener(_type: 'message', listener: (e: { data: unknown }) => void): void { this.listener = listener; }
  removeEventListener(): void { this.listener = null; }
}

function makeHost(mod: HookModule, opts?: { hardMs?: number; bridge?: MessageBridge; silent?: boolean }) {
  const created: FakeWorker[] = [];
  const host = new ScriptHost({
    hardMs: opts?.hardMs ?? 200,
    loadModule: async () => mod,
    bridge: opts?.bridge ?? createMockBridge(),
    createWorker: () => {
      const w = new FakeWorker(mod, new Set(Object.keys(mod)), opts?.silent ?? false);
      created.push(w);
      return w;
    },
  });
  return { host, created };
}

const binding: ScriptBinding = { scriptId: 's1', hook: 'onLoad', contentHash: 'h1', sourceHash: 'sh1' };

describe('ScriptHost 执行器', () => {
  it('无绑定钩子返回 skipped', async () => {
    const { host } = makeHost({});
    const r = await host.run('onLoad', {}, new Map());
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
  });

  it('正常执行返回值透传', async () => {
    const { host } = makeHost({ onLoad: () => 42 });
    const r = await host.run('onLoad', {}, new Map([['onLoad', binding]]));
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
  });

  it('钩子异常不白屏：返回 ok=false 页面继续', async () => {
    const { host } = makeHost({ onLoad: () => { throw new Error('boom'); } });
    const r = await host.run('onLoad', {}, new Map([['onLoad', binding]]));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('boom');
  });

  it('同步死循环超时真终止：terminate 生效、主线程恢复', async () => {
    // 死循环在 vitest 工作线程内会永久卡死事件循环——单测断言的是 ScriptHost 的双通道超时
    // 协议（terminate + 主线程超时拒绝），fake worker 模拟「收到 run 后挂起不回复」（真实死循环
    // 对消息协议的表现完全一致：永不 hook-done）。真实浏览器内 while(true) 物理终止属 E2E 验收
    // （08FE §8 第三项），不在本单测范围。
    const silent = { onLoad: () => 1 } as unknown as HookModule; // 有钩子但 worker 静默挂起
    const { host, created } = makeHost(silent, { hardMs: 120, silent: true });
    const r = await host.run('onLoad', {}, new Map([['onLoad', binding]]));
    expect(r.ok).toBe(false);
    expect(r.terminated).toBe(true);
    expect(r.error).toContain('硬终止');
    expect(created[0].terminated).toBe(true);
    expect(r.durationMs).toBeLessThan(2000); // 主线程恢复（不被挂起的调用卡死）
  });

  it('终止后池位重建（复用语义）', async () => {
    const mod = { onLoad: () => 1 } as unknown as HookModule;
    const { host, created } = makeHost(mod, { hardMs: 100 });
    await host.run('onLoad', {}, new Map([['onLoad', binding]]));
    expect(created.length).toBe(1);
    expect(created[0].terminated).toBe(false); // 正常完成不 terminate
    // 超时终止后复用：同 hash 再跑 → 池位重建新 worker
    const { host: h2, created: c2 } = makeHost({ onLoad: () => 1 } as unknown as HookModule, { hardMs: 60, silent: true });
    await h2.run('onLoad', {}, new Map([['onLoad', binding]])); // 超时终止 → 池位重建 B
    const r2 = await h2.run('onLoad', {}, new Map([['onLoad', binding]])); // 复用 B → 再超时 → 重建 C
    expect(r2.terminated).toBe(true);
    expect(c2.length).toBe(3); // 初始 A + 重建 B + 重建 C——每次终止后池位都以新 worker 复用
    h2.dispose();
    host.dispose();
  });

  it('dispose：全部 worker terminate 且后续调用拒绝', async () => {
    const { host, created } = makeHost({ onLoad: () => 1 });
    await host.run('onLoad', {}, new Map([['onLoad', binding]]));
    host.dispose();
    expect(created[0].terminated).toBe(true);
    const r = await host.run('onLoad', {}, new Map([['onLoad', binding]]));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('disposed');
  });

  it('池上限 LRU 回收空闲 worker', async () => {
    const created: FakeWorker[] = [];
    const host = new ScriptHost({
      poolSize: 2,
      hardMs: 200,
      loadModule: async () => ({ onLoad: () => 1 }),
      bridge: createMockBridge(),
      createWorker: () => { const w = new FakeWorker({ onLoad: () => 1 }, new Set(['onLoad'])); created.push(w); return w; },
    });
    const mk = (hash: string): ScriptBinding => ({ scriptId: hash, hook: 'onLoad', contentHash: hash, sourceHash: hash });
    await host.run('onLoad', {}, new Map([['onLoad', mk('a')]]));
    await host.run('onLoad', {}, new Map([['onLoad', mk('b')]]));
    await host.run('onLoad', {}, new Map([['onLoad', mk('c')]]));
    expect(created.length).toBe(3);
    expect(created[0].terminated).toBe(true); // LRU 最早池位被回收
    host.dispose();
  });
});

describe('消息桥与 ctx 代理', () => {
  it('白名单外 op 被拒收', async () => {
    const bridge = createMockBridge();
    const r = await bridge.dispatch('fs.read', ['/etc/passwd']);
    expect(r.ok).toBe(false);
    expect(r.err).toContain('不在白名单');
  });

  it('ctx 方法调用产生合法 op 消息', async () => {
    const bridge = createMockBridge();
    const ctx = createWorkerCtx(
      (op, args) => bridge.dispatch(op, args),
      { id: 'u1', roles: ['user'] },
      { params: {}, query: {}, mode: 'preview' },
    );
    await ctx.form.set('amount', 5);
    await ctx.api.call('unique-check', { key: 'code' });
    ctx.logger.warn('careful');
    expect(bridge.calls.map((c) => c.op)).toEqual(['form.set', 'api.call', 'log']);
    expect(bridge.calls[1].args).toEqual(['unique-check', { key: 'code' }]);
    // token 不进消息流：args 中无凭证字段
    expect(JSON.stringify(bridge.calls)).not.toMatch(/token|authorization|bearer/i);
  });

  it('静态快照注入：user 字段恰为白名单', () => {
    const ctx = createWorkerCtx(async () => ({ ok: true }), { id: 'u1', roles: ['user'], dept: 'd1' }, { params: {}, query: {}, mode: 'preview' });
    expect(Object.keys(ctx.user ?? {})).toEqual(['id', 'roles', 'dept']);
  });
});
