/**
 * ScriptHost 执行器（08FE §4 第三道闸——真正的安全边界）：
 * - Worker 隔离：DOM 不可达、token 不进执行环境、消息桥 op 白名单
 * - 超时硬中断：worker.terminate() 真终止同步死循环（Promise.race/AbortSignal 做不到）
 * - 钩子异常不白屏：run() 永不抛出，返回 { ok:false } 页面继续
 */
import type { HookName, HookModule, HookResult, ScriptBinding, ScriptContext } from './types';

export interface ScriptHostOptions {
  /** 每页面实例独立 worker 池上限（08FE §4.3：LRU 释放）。 */
  poolSize?: number;
  warnMs?: number;
  hardMs?: number;
  /** 产物加载器：contentHash → 可执行模块（测试台与线上同构——保真承诺 §6）。 */
  loadModule(contentHash: string): Promise<HookModule>;
  /** 主线程消息桥实现（op 白名单校验在此层）。 */
  bridge: MessageBridge;
  /** Worker 工厂：返回未初始化的 Worker（init 握手由 ScriptHost 统一驱动）。 */
  createWorker(contentHash: string): WorkerLike;
  /** 静态快照（08FE §5：mount 时一次性注入，脱敏白名单）。 */
  staticUser?: ScriptContext['user'];
  staticPage?: ScriptContext['page'];
  /** 产物 URL（module worker import 目标；缺省时 Worker 自行闭包加载——兼容旧工厂）。 */
  artifactUrl?: (contentHash: string) => string;
}

export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (e: { data: unknown }) => void): void;
}

/** 主线程消息桥：唯一合法指令集（08FE §4.2 op 表）；白名单外 op 拒收。 */
export interface MessageBridge {
  /** 返回 false = 拒收（非法 op）。 */
  dispatch(op: string, args: unknown[]): Promise<{ ok: boolean; result?: unknown; err?: string }>;
}

interface PoolEntry {
  worker: WorkerLike;
  busy: boolean;
}

/** Worker 协议消息形态（与 worker-bootstrap.ts 对齐——单一协议真源两侧镜像）。 */
type WorkerMsg =
  | { type: 'ready'; ok: boolean; err?: string }
  | { type: 'ctx-call'; id: string; op: string; args: unknown[] }
  | { type: 'hook-done'; ok: boolean; value?: unknown; err?: string };

export class ScriptHost {
  private readonly pool = new Map<string, PoolEntry>();
  private readonly poolOrder: string[] = [];
  private readonly poolSize: number;
  private readonly warnMs: number;
  private readonly hardMs: number;
  private readonly options: ScriptHostOptions;
  private disposed = false;

  constructor(options: ScriptHostOptions) {
    this.options = options;
    this.poolSize = options.poolSize ?? 8;
    this.warnMs = options.warnMs ?? 500;
    this.hardMs = options.hardMs ?? 10_000;
  }

  /** 执行钩子：无绑定返回 skipped；异常/超时返回 { ok:false }，永不抛出（不白屏）。 */
  async run(hook: HookName, payload: unknown, bindings: Map<HookName, ScriptBinding>): Promise<HookResult> {
    const started = Date.now();
    if (this.disposed) return { ok: false, error: 'disposed', durationMs: 0 };
    const binding = bindings.get(hook);
    if (!binding) return { ok: true, skipped: true, durationMs: Date.now() - started };

    let entry = this.pool.get(binding.contentHash);
    if (entry && !entry.busy) {
      // 复用池位
    } else if (!entry) {
      entry = { worker: this.options.createWorker(binding.contentHash), busy: false };
      this.pool.set(binding.contentHash, entry);
      this.poolOrder.push(binding.contentHash);
      this.evictIfNeeded();
    } else {
      // 同 hash 在途：新建临时 worker 执行（不占池位，用后即弃）
      return this.runOnWorker({ worker: this.options.createWorker(binding.contentHash), busy: false }, hook, payload, binding, started, true);
    }
    return this.runOnWorker(entry, hook, payload, binding, started, false);
  }

  private async runOnWorker(entry: PoolEntry, hook: HookName, payload: unknown, binding: ScriptBinding, started: number, tempWorker: boolean): Promise<HookResult> {
    entry.busy = true;
    let terminated = false;
    try {
      // 常驻分派器统一处理 ready/ctx-call/hook-done 三类消息；init 由宿主显式驱动——
      // ready 后再发 run（消除异步 import 竞态）；ctx-call 由桥分派并回执 ctx-result。
      const dispatcher = this.attachDispatcher(entry.worker);
      entry.worker.postMessage({
        type: 'init',
        artifactUrl: this.options.artifactUrl?.(binding.contentHash),
        staticUser: this.options.staticUser,
        staticPage: this.options.staticPage,
      });
      const ready = await this.awaitReady(entry.worker, dispatcher.ready);
      if (!ready.ok) {
        return { ok: false, error: ready.err ?? 'worker 初始化失败', durationMs: Date.now() - started };
      }
      // ⚠️ 超时硬中断双通道（08FE §4.3）：
      //   ① worker.terminate() —— 真终止执行线程（同步死循环被物理停止）
      //   ② 主线程 Promise 超时拒绝 —— terminate 只杀 worker，不会让本 await settle；
      //      缺②时即使 worker 已死，主线程 await 也永久挂起（事件循环被 pending Promise 卡住）
      const callPromise = this.invoke(entry.worker, hook, payload, binding);
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        hardTimer = setTimeout(() => {
          terminated = true;
          entry.worker.terminate(); // ① 硬中断：真终止执行线程
          reject(new Error(`hook 超时 ${this.hardMs}ms（已硬终止）`)); // ② 主线程超时拒绝：让 await settle
        }, this.hardMs);
      });
      let warned = false;
      const warnTimer = setTimeout(() => { warned = true; }, this.warnMs); // warn：日志告警（08FE §4.3）
      try {
        const result = await Promise.race([callPromise, timeoutPromise]);
        return { ...result, durationMs: Date.now() - started, warned };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - started, warned, terminated };
      } finally {
        if (hardTimer) clearTimeout(hardTimer);
        clearTimeout(warnTimer);
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - started };
    } finally {
      entry.worker.removeEventListener('message', this.currentListener ?? (() => {}));
      this.currentListener = undefined;
      if (terminated || tempWorker) {
        entry.worker.terminate(); // 终止后重建（复用池位语义）或丢弃临时 worker
        if (!tempWorker) {
          this.pool.set(binding.contentHash, { worker: this.options.createWorker(binding.contentHash), busy: false });
        }
      } else {
        entry.busy = false;
      }
    }
  }

  /** 当前挂载的常驻 message 监听（runOnWorker finally 卸载）。 */
  private currentListener: ((e: { data: unknown }) => void) | undefined;

  /**
   * 常驻消息分派器（08FE §4.2 桥的真实接线）：
   * - ready：init 完成信号（Promise 化握手）
   * - ctx-call：Worker 发起的桥调用 → bridge.dispatch（op 白名单在此校验）→ 回执 ctx-result
   * - hook-done：由 invoke 的一次性监听消费；此分派器转发兜底（不重复 resolve）
   */
  private attachDispatcher(worker: WorkerLike): { ready: Promise<{ ok: boolean; err?: string }> } {
    let resolveReady!: (r: { ok: boolean; err?: string }) => void;
    const ready = new Promise<{ ok: boolean; err?: string }>((resolve) => { resolveReady = resolve; });
    const listener = (e: { data: unknown }): void => {
      const msg = e.data as WorkerMsg;
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      if (msg.type === 'ready') {
        resolveReady({ ok: msg.ok, err: msg.err });
      } else if (msg.type === 'ctx-call') {
        void this.options.bridge.dispatch(msg.op, msg.args).then((r) => {
          worker.postMessage({ type: 'ctx-result', id: msg.id, ok: r.ok, result: r.result, err: r.err });
        });
      } else if (msg.type === 'hook-done') {
        resolveReady({ ok: true }); // 钩子先于 ready 完成的兜底（正常序 ready 必先到）
      }
    };
    worker.addEventListener('message', listener);
    this.currentListener = listener;
    return { ready };
  }

  /** 等待 init 完成（ready 消息或已加载短路）；超时防 Worker 构造即挂死。 */
  private async awaitReady(_worker: WorkerLike, ready: Promise<{ ok: boolean; err?: string }>): Promise<{ ok: boolean; err?: string }> {
    return Promise.race([
      ready,
      new Promise<{ ok: false; err: string }>((resolve) => setTimeout(() => resolve({ ok: false, err: 'worker 初始化超时' }), 5_000)),
    ]);
  }

  private invoke(worker: WorkerLike, hook: HookName, payload: unknown, binding: ScriptBinding): Promise<{ ok: boolean; value?: unknown; warned?: boolean }> {
    return new Promise((resolve, reject) => {
      const onMessage = (e: { data: unknown }): void => {
        const data = e.data as { type?: string; ok?: boolean; value?: unknown; err?: string };
        if (data?.type === 'hook-done') {
          worker.removeEventListener('message', onMessage);
          if (data.ok) resolve({ ok: true, value: data.value });
          else reject(new Error(data.err ?? 'hook failed'));
        }
      };
      worker.addEventListener('message', onMessage);
      worker.postMessage({ type: 'run', hook, payload, scriptId: binding.scriptId });
    });
  }

  private evictIfNeeded(): void {
    while (this.poolOrder.length > this.poolSize) {
      const oldest = this.poolOrder.shift();
      if (!oldest) break;
      const victim = this.pool.get(oldest);
      if (victim && !victim.busy) {
        victim.worker.terminate();
        this.pool.delete(oldest);
      } else if (victim) {
        this.poolOrder.push(oldest); // 在途不回收，轮空再试
        break;
      }
    }
  }

  /** 页面卸载 dispose：池回收 + 进行中调用放弃（归还前 terminate 防僵尸）。 */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.pool.values()) entry.worker.terminate();
    this.pool.clear();
    this.poolOrder.length = 0;
  }
}

/** 测试台辅助：同一 ScriptHost + mock 桥（保真承诺——执行器/消息桥/扫描器为同一实例）。 */
export function createMockBridge(overrides?: Partial<Record<string, (args: unknown[]) => unknown>>, initialForm?: Record<string, unknown>): MessageBridge & { calls: Array<{ op: string; args: unknown[] }>; form: Record<string, unknown> } {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const form: Record<string, unknown> = { ...(initialForm ?? {}) };
  const handlers: Record<string, (args: unknown[]) => unknown> = {
    'form.get': (args) => form[args[0] as string],
    'form.set': (args) => { form[args[0] as string] = args[1]; return undefined; },
    'form.getValues': () => form,
    'form.setValues': (args) => { Object.assign(form, args[0] as Record<string, unknown>); return undefined; },
    'api.call': () => ({ ok: true }),
    'ui.toast': () => undefined,
    'ui.confirm': () => true,
    'ui.dialog': () => undefined,
    'log': () => undefined,
    ...overrides,
  };
  return {
    calls,
    form,
    async dispatch(op, args) {
      calls.push({ op, args });
      const handler = handlers[op];
      if (!handler) return { ok: false, err: `op 不在白名单: ${op}` };
      try {
        return { ok: true, result: await handler(args) };
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/** 构造 Worker 内 ctx 代理（08FE §4.2）：每方法一次 postMessage 往返，无本地能力。 */
export function createWorkerCtx(post: (op: string, args: unknown[]) => Promise<{ ok: boolean; result?: unknown; err?: string }>, staticUser: ScriptContext['user'], staticPage: ScriptContext['page']): ScriptContext {
  const call = (op: string, args: unknown[]): Promise<unknown> =>
    post(op, args).then((r) => {
      if (!r.ok) throw new Error(r.err ?? `op 失败: ${op}`);
      return r.result;
    });
  const callVoid = (op: string, args: unknown[]): Promise<void> => call(op, args).then(() => undefined);
  const logger = (level: string) => (message: string, extra?: unknown) => { void callVoid('log', [level, message, extra]); };
  return {
    form: {
      get: (fieldKey) => call('form.get', [fieldKey]) as Promise<unknown>,
      set: (fieldKey, value) => callVoid('form.set', [fieldKey, value]),
      getValues: () => call('form.getValues', []) as Promise<Record<string, unknown>>,
      setValues: (values) => callVoid('form.setValues', [values]),
    },
    api: { call: (name, params) => call('api.call', [name, params]) },
    ui: {
      toast: (message, level) => callVoid('ui.toast', [message, level]),
      confirm: (message) => call('ui.confirm', [message]) as Promise<boolean>,
      dialog: (config) => callVoid('ui.dialog', [config]),
    },
    logger: { debug: logger('debug'), info: logger('info'), warn: logger('warn'), error: logger('error') },
    user: staticUser,
    page: staticPage,
  };
}
