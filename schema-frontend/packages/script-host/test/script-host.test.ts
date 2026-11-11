/**
 * ScriptHost 执行器测试（08FE §8）：超时真终止、异常不白屏、池回收、消息桥白名单拒收。
 * FakeWorker 为 worker-bootstrap.ts 协议的真实镜像：init→ready 握手、run→钩子执行
 * （fn(payload, ctx) 两参契约）、ctx-call→宿主桥 dispatch→ctx-result 往返、静态快照来自 init。
 * 终止行为按真实 worker 语义（终止后不再派发消息）。
 */
import { describe, expect, it, vi } from 'vitest';
import { ScriptHost, createMockBridge, createWorkerCtx } from '../src/script-host';
import type { WorkerLike, MessageBridge } from '../src/script-host';
import type { HookModule, ScriptBinding } from '../src/types';

class FakeWorker implements WorkerLike {
  terminated = false;
  private listeners = new Set<(e: { data: unknown }) => void>();
  private staticUser: unknown;
  private staticPage: unknown;
  constructor(
    private readonly mod: HookModule,
    private readonly silent = false,
    private readonly initDelayMs = 0,
  ) {}
  postMessage(message: unknown): void {
    if (this.terminated) return;
    const msg = message as { type: string; staticUser?: unknown; staticPage?: unknown; hook?: string; payload?: unknown };
    if (msg.type === 'init') {
      this.staticUser = msg.staticUser;
      this.staticPage = msg.staticPage;
      setTimeout(() => {
        if (!this.terminated) this.emit({ type: 'ready', ok: true });
      }, this.initDelayMs);
      return;
    }
    if (msg.type === 'ctx-result') {
      // 宿主回执：消费 ctx-call 的 pending promise（镜像 bootstrap 的 waiting Map）
      this.pendingResolve?.(msg.id, msg.ok, msg.result, msg.err);
      return;
    }
    if (msg.type !== 'run') return;
    if (this.silent) return; // 静默模式：收到 run 不回复（模拟死循环对协议的表现）
    setTimeout(async () => {
      if (this.terminated) return; // 终止后消息不再派发——真实 worker 语义
      const fn = this.mod[msg.hook as string];
      if (typeof fn !== 'function') {
        this.emit({ type: 'hook-done', ok: false, err: `钩子未导出: ${msg.hook}` });
        return;
      }
      // ctx 代理：镜像 worker-bootstrap 的 call —— postMessage ctx-call，等宿主回 ctx-result
      const waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
      const call = (op: string, args: unknown[]): Promise<unknown> =>
        new Promise((resolve, reject) => {
          const id = `id-${waiting.size}-${op}`;
          waiting.set(id, { resolve, reject });
          this.emit({ type: 'ctx-call', id, op, args });
        });
      const ctx = {
        form: {
          get: (k: string) => call('form.get', [k]),
          set: (k: string, v: unknown) => call('form.set', [k, v]).then(() => undefined),
          getValues: () => call('form.getValues', []),
          setValues: (v: unknown) => call('form.setValues', [v]).then(() => undefined),
        },
        api: { call: (n: string, p: unknown) => call('api.call', [n, p]) },
        ui: { toast: (m: string, l?: string) => call('ui.toast', [m, l]).then(() => undefined) },
        logger: { warn: (m: string) => { void call('log', ['warn', m]); } },
        user: this.staticUser,
        page: this.staticPage,
      };
      // 宿主回执处理由 receiveResult 注入；ctx-call 发出后宿主桥分派再回执
      this.pendingResolve = (id: string, ok: boolean, result: unknown, err?: string) => {
        const p = waiting.get(id);
        if (!p) return;
        waiting.delete(id);
        ok ? p.resolve(result) : p.reject(new Error(err ?? 'op 失败'));
      };
      try {
        const value = await (fn as (payload: unknown, ctx: unknown) => unknown)(msg.payload, ctx);
        this.emit({ type: 'hook-done', ok: true, value });
      } catch (e) {
        this.emit({ type: 'hook-done', ok: false, err: e instanceof Error ? e.message : String(e) });
      }
    }, 0);
  }
  private pendingResolve: ((id: string, ok: boolean, result: unknown, err?: string) => void) | null = null;
  /** 宿主侧模拟：ScriptHost 回执 ctx-result 时注入钩子 promise。 */
  receiveResult(id: string, ok: boolean, result: unknown, err?: string): void {
    this.pendingResolve?.(id, ok, result, err);
  }
  private emit(data: unknown): void {
    for (const l of [...this.listeners]) l({ data });
  }
  terminate(): void { this.terminated = true; }
  addEventListener(_type: 'message', listener: (e: { data: unknown }) => void): void { this.listeners.add(listener); }
  removeEventListener(_type: 'message', listener: (e: { data: unknown }) => void): void { this.listeners.delete(listener); }
}

function makeHost(mod: HookModule, opts?: { hardMs?: number; bridge?: MessageBridge; silent?: boolean; initDelayMs?: number; staticUser?: unknown; staticPage?: unknown }) {
  const created: FakeWorker[] = [];
  const host = new ScriptHost({
    hardMs: opts?.hardMs ?? 200,
    loadModule: async () => mod,
    bridge: opts?.bridge ?? createMockBridge(),
    staticUser: opts?.staticUser,
    staticPage: opts?.staticPage,
    createWorker: () => {
      const w = new FakeWorker(mod, opts?.silent ?? false, opts?.initDelayMs ?? 0);
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
      createWorker: () => { const w = new FakeWorker({ onLoad: () => 1 }); created.push(w); return w; },
    });
    const mk = (hash: string): ScriptBinding => ({ scriptId: hash, hook: 'onLoad', contentHash: hash, sourceHash: hash });
    await host.run('onLoad', {}, new Map([['onLoad', mk('a')]]));
    await host.run('onLoad', {}, new Map([['onLoad', mk('b')]]));
    await host.run('onLoad', {}, new Map([['onLoad', mk('c')]]));
    expect(created.length).toBe(3);
    expect(created[0].terminated).toBe(true); // LRU 最早池位被回收
    host.dispose();
  });

  it('真实桥往返：钩子内 ctx.form.get 经宿主桥取值（协议镜像——ctx-call→dispatch→ctx-result）', async () => {
    // 修复回归：invoke 只认 hook-done 时，ctx-call 被静默丢弃、调用挂起直到超时
    const bridge = createMockBridge(undefined, { amount: '20000' });
    const mod = {
      beforeSubmit: async (_payload: unknown, ctx: { form: { get(k: string): Promise<unknown> } }) =>
        Number(await ctx.form.get('amount')),
    } as unknown as HookModule;
    const { host } = makeHost(mod, { hardMs: 500, bridge });
    const r = await host.run('beforeSubmit', { record: { amount: '20000' } }, new Map([['beforeSubmit', { ...binding, hook: 'beforeSubmit' }]]));
    expect(r.ok).toBe(true);
    expect(r.value).toBe(20000); // 桥真实往返后取到 mock 表单值
    expect(bridge.calls.some((c) => c.op === 'form.get')).toBe(true);
  });

  it('宿主拒绝非法 op，即使桥实现允许任意操作', async () => {
    const dispatch = vi.fn(async () => ({ ok: true }));
    const worker = new FakeWorker({ onLoad: () => 1 });
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message: unknown) => {
      const msg = message as { type: string; err?: string };
      if (msg.type === 'run') {
        const listeners = (worker as unknown as { listeners: Set<(e: { data: unknown }) => void> }).listeners;
        for (const listener of [...listeners]) listener({ data: { type: 'ctx-call', id: 'illegal', op: 'fs.read', args: [] } });
      } else if (msg.type === 'ctx-result') {
        expect(msg.err).toContain('不在白名单');
      }
      post(message);
    };
    const host = new ScriptHost({ loadModule: async () => ({}), createWorker: () => worker, bridge: { dispatch } });
    const result = await host.run('onLoad', {}, new Map([['onLoad', binding]]));
    expect(result.ok).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    host.dispose();
  });

  it('消息桥拒绝转为钩子错误而不是挂起超时', async () => {
    const mod = {
      onLoad: async (_p: unknown, ctx: { form: { get(k: string): Promise<unknown> } }) => ctx.form.get('amount'),
    } as unknown as HookModule;
    const { host } = makeHost(mod, { bridge: { dispatch: async () => { throw new Error('bridge rejected'); } } });
    const result = await host.run('onLoad', {}, new Map([['onLoad', binding]]));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('bridge rejected');
    expect(result.terminated).not.toBe(true);
    host.dispose();
  });

  it('卸载立即取消在途调用且不重建 Worker', async () => {
    const { host, created } = makeHost({ onLoad: () => 1 }, { silent: true, hardMs: 10000 });
    const first = host.run('onLoad', {}, new Map([['onLoad', binding]]));
    const second = host.run('onLoad', {}, new Map([['onLoad', binding]]));
    host.dispose();
    const results = await Promise.all([first, second]);
    expect(results.every((r) => !r.ok && r.error === 'disposed')).toBe(true);
    expect(created.length).toBe(2);
    expect(created.every((w) => w.terminated)).toBe(true);
    for (const worker of created) {
      expect((worker as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
    }
  });

  it('并发执行各自释放消息监听', async () => {
    const { host, created } = makeHost({ onLoad: () => 7 });
    const results = await Promise.all([
      host.run('onLoad', {}, new Map([['onLoad', binding]])),
      host.run('onLoad', {}, new Map([['onLoad', { ...binding, contentHash: 'h2' }]])),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    for (const worker of created) {
      expect((worker as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
    }
    host.dispose();
  });

  it('钩子未导出返回错误（模块无该钩子）', async () => {
    const { host } = makeHost({ afterSubmit: () => 1 } as unknown as HookModule);
    const r = await host.run('onLoad', {}, new Map([['onLoad', binding]]));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('钩子未导出');
  });

  it('ready 竞态：init 异步未完成不发 run——初始化慢于调用不被「module 未加载」误杀', async () => {
    const mod = { onLoad: () => 7 } as unknown as HookModule;
    const { host } = makeHost(mod, { hardMs: 1000, initDelayMs: 60 });
    const r = await host.run('onLoad', {}, new Map([['onLoad', binding]]));
    expect(r.ok).toBe(true);
    expect(r.value).toBe(7);
  });

  it('静态快照经 init 注入：钩子读取 ctx.user/ctx.page 为宿主携带值（修复回归——曾从 run 消息读取恒 undefined）', async () => {
    const seen: { user?: unknown; page?: unknown } = {};
    const mod = {
      onLoad: async (_p: unknown, ctx: { user?: unknown; page?: unknown }) => {
        seen.user = ctx.user;
        seen.page = ctx.page;
        return 1;
      },
    } as unknown as HookModule;
    const staticUser = { id: 'u1', roles: ['developer'] };
    const staticPage = { params: {}, query: {}, mode: 'design' };
    const { host } = makeHost(mod, { staticUser, staticPage });
    await host.run('onLoad', {}, new Map([['onLoad', binding]]));
    expect(seen.user).toEqual(staticUser);
    expect(seen.page).toEqual(staticPage);
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
    const bridge = createMockBridge(undefined, { amount: 5 });
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
    // mock 桥表单状态真实可读（form.get 返回 set 写入的值）
    await expect(ctx.form.get('amount')).resolves.toBe(5);
  });

  it('静态快照注入：user 字段恰为白名单', () => {
    const ctx = createWorkerCtx(async () => ({ ok: true }), { id: 'u1', roles: ['user'], dept: 'd1' }, { params: {}, query: {}, mode: 'preview' });
    expect(Object.keys(ctx.user ?? {})).toEqual(['id', 'roles', 'dept']);
  });
});
