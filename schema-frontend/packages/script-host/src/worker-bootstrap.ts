/**
 * Worker 入口工厂（08FE §4）：把编译产物包装为可执行钩子模块。
 * 入口脚本由 Blob URL 构造（同源 dedicated worker）；产物经 import() 动态加载——
 * 产物响应头 CSP connect-src 'none' 不影响 import()（script-src 域，04BE §2.5②）。
 *
 * 协议（与 ScriptHost.invoke 对齐）：
 *   入 → { type:'init', artifactUrl | source, staticUser, staticPage }
 *   入 → { type:'run', hook, payload }
 *   出 ← { type:'hook-done', ok, value?, err? }
 *   出 ← { type:'ctx-call', id, op, args }          ← 消息桥（主线程白名单校验后回执）
 *   入 → { type:'ctx-result', id, ok, result?, err? }
 */
export const WORKER_BOOTSTRAP = `
const waiting = new Map();
let mod = null;
let staticUser = undefined;
let staticPage = undefined;
self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    try {
      staticUser = msg.staticUser;
      staticPage = msg.staticPage;
      mod = msg.artifactUrl ? await import(msg.artifactUrl) : null;
      self.postMessage({ type: 'ready', ok: !!mod });
    } catch (err) {
      self.postMessage({ type: 'ready', ok: false, err: String(err) });
    }
    return;
  }
  if (msg.type === 'ctx-result') {
    const p = waiting.get(msg.id);
    if (p) { waiting.delete(msg.id); msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.err)); }
    return;
  }
  if (msg.type === 'run') {
    if (!mod) { self.postMessage({ type: 'hook-done', ok: false, err: 'module 未加载' }); return; }
    const call = (op, args) => new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      waiting.set(id, { resolve, reject });
      self.postMessage({ type: 'ctx-call', id, op, args });
    });
    const callVoid = (op, args) => call(op, args).then(() => undefined);
    const logger = (level) => (message, extra) => { void callVoid('log', [level, message, extra]); };
    const ctx = {
      form: {
        get: (k) => call('form.get', [k]),
        set: (k, v) => callVoid('form.set', [k, v]),
        getValues: () => call('form.getValues', []),
        setValues: (v) => callVoid('form.setValues', [v]),
      },
      api: { call: (n, p) => call('api.call', [n, p]) },
      ui: {
        toast: (m, l) => callVoid('ui.toast', [m, l]),
        confirm: (m) => call('ui.confirm', [m]),
        dialog: (c) => callVoid('ui.dialog', [c]),
      },
      logger: { debug: logger('debug'), info: logger('info'), warn: logger('warn'), error: logger('error') },
      user: staticUser,
      page: staticPage,
    };
    try {
      const fn = mod[msg.hook];
      if (typeof fn !== 'function') {
        self.postMessage({ type: 'hook-done', ok: false, err: '钩子未导出: ' + msg.hook });
        return;
      }
      const value = await fn(msg.payload, ctx);
      self.postMessage({ type: 'hook-done', ok: true, value });
    } catch (err) {
      self.postMessage({ type: 'hook-done', ok: false, err: err && err.stack ? err.stack : String(err) });
    }
  }
};
`;

/** Worker 句柄：dispose 终止 Worker 并释放 Blob URL（幂等）——真实 Worker 无释放钩子，包装层统一回收。 */
export interface ScriptWorkerHandle {
  worker: Worker;
  dispose(): void;
}

/** 构造真实 Worker（Blob 入口 + 产物 import）；init 握手由 ScriptHost 驱动（构造期不发送——
 *  消息监听挂载先于 init，避免 ready 早于监听就绪被丢弃）。 */
export function createScriptWorker(artifactUrl?: string, staticUser?: unknown, staticPage?: unknown): ScriptWorkerHandle {
  const blob = new Blob([WORKER_BOOTSTRAP], { type: 'text/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  const worker = new Worker(blobUrl, { type: 'module' });
  if (artifactUrl !== undefined) {
    // 兼容旧调用（构造期直发 init）；新链路由 ScriptHost 统一 postMessage init
    worker.postMessage({ type: 'init', artifactUrl, staticUser, staticPage });
  }
  let disposed = false;
  return {
    worker,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try { worker.terminate(); } finally { URL.revokeObjectURL(blobUrl); }
    },
  };
}
