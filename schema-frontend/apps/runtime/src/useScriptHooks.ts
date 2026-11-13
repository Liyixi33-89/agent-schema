/**
 * M14 runtime 页面脚本消费（08FE §4 线上执行器接线）：
 * - PageSchema.scripts → ScriptHost（Worker 隔离 + terminate 硬中断——与测试台同一执行器）
 * - 真实消息桥：form.* 直连 FormStore；api.call 走 RequestClient（宿主代理——Worker 不持 token）；
 *   ui.* 走 antd；log 落 console（审计面后端埋点随 P2）
 * - 钩子调度点（08FE §4.3）：挂载完成 onLoad；提交前 beforeSubmit（false 阻断）；提交后 afterSubmit
 * - 韧性原则：脚本报错/超时不白屏不阻断（超时按「不阻断」放行）
 */
import React from 'react';
import { message as antdMessage, Modal, Typography } from 'antd';
import {
  ScriptHost, createScriptWorker, BRIDGE_OPS,
  type HookName, type HookResult, type ScriptBinding, type WorkerLike,
} from '@schema/script-host';
import type { FormStore } from '@schema/schema-form';
import type { PageSchema } from '@schema/schema-protocol';
import type { RequestClient } from './request';

export interface ScriptHooksOptions {
  page: PageSchema;
  store: FormStore;
  client: RequestClient;
  recordId?: string | number;
}

export interface ScriptHooks {
  /** 页面脚本是否存在绑定（false 时宿主可完全跳过钩子开销）。 */
  enabled: boolean;
  onLoad: () => Promise<HookResult>;
  beforeSubmit: (payload: { record: Record<string, unknown> }) => Promise<HookResult>;
  afterSubmit: (payload: { record: Record<string, unknown>; result: unknown }) => Promise<HookResult>;
  onActionClick: (actionKey: string) => Promise<HookResult>;
  /** 字段变化通知（宿主节流后调度——08FE §4.3「表单字段变更钩子节流 50ms」）。 */
  notifyFieldChange: (fieldKey: string, value: unknown) => void;
  /** 是否绑定 onFieldChange（宿主据此决定是否订阅字段变化）。 */
  hasFieldChangeHook: boolean;
}

/** 真实消息桥（op 白名单 BRIDGE_OPS 之外一律拒收——08FE §4.2）。 */
function createRuntimeBridge(store: FormStore, client: RequestClient): {
  dispatch(op: string, args: unknown[]): Promise<{ ok: boolean; result?: unknown; err?: string }>;
} {
  return {
    async dispatch(op, args) {
      if (!(BRIDGE_OPS as readonly string[]).includes(op)) {
        return { ok: false, err: `非法操作: ${op}` };
      }
      try {
        switch (op) {
          case 'form.get': return { ok: true, result: store.get(String(args[0])) };
          case 'form.set': store.set(String(args[0]), args[1]); return { ok: true };
          case 'form.getValues': {
            const values: Record<string, unknown> = {};
            for (const key of store.fields.keys()) values[key] = store.get(key);
            return { ok: true, result: values };
          }
          case 'form.setValues': {
            const patch = (args[0] ?? {}) as Record<string, unknown>;
            for (const [k, v] of Object.entries(patch)) store.set(k, v);
            store.refreshEffects();
            return { ok: true };
          }
          case 'api.call': {
            // 注册名代理（08FE §5：不接受 URL；权限校验在服务端——Worker 不持 token）
            const [name, params] = args as [string, unknown?];
            if (typeof name !== 'string' || !name) return { ok: false, err: 'api.call 需要注册名' };
            const resp = await client.get(`/api/scripts/apis/${encodeURIComponent(name)}${params ? `?params=${encodeURIComponent(JSON.stringify(params))}` : ''}`);
            if (!resp.ok) return { ok: false, err: `api 调用失败 (${resp.status})` };
            const text = await resp.text();
            return { ok: true, result: text ? JSON.parse(text) : null };
          }
          case 'ui.toast': {
            const [msg, level] = args as [string, ('info' | 'success' | 'warning' | 'error')?];
            antdMessage.open({ type: level ?? 'info', content: String(msg ?? '') });
            return { ok: true };
          }
          case 'ui.confirm': {
            const confirmed = await new Promise<boolean>((resolve) => {
              Modal.confirm({
                content: String(args[0] ?? ''),
                onOk: () => resolve(true),
                onCancel: () => resolve(false),
              });
            });
            return { ok: true, result: confirmed };
          }
          case 'ui.dialog': {
            const cfg = (args[0] ?? {}) as { title?: string; content?: string };
            Modal.info({
              title: cfg.title ?? '',
              content: React.createElement(Typography.Paragraph, null, String(cfg.content ?? '')),
            });
            return { ok: true };
          }
          case 'log': {
            // 运行态日志落 console（开发者工具可见）；审计面后端落库随 P2 完整版
            // eslint-disable-next-line no-console
            console.info('[script]', ...(args as unknown[]));
            return { ok: true };
          }
          default:
            return { ok: false, err: `未实现操作: ${op}` };
        }
      } catch (e) {
        return { ok: false, err: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

export function useScriptHooks({ page, store, client, recordId }: ScriptHooksOptions): ScriptHooks {
  const bindings = React.useMemo(() => {
    const map = new Map<HookName, ScriptBinding>();
    for (const s of page.scripts ?? []) {
      map.set(s.hook, { scriptId: s.scriptId, hook: s.hook, contentHash: s.contentHash, sourceHash: s.sourceHash });
    }
    return map;
  }, [page.scripts]);

  const hostRef = React.useRef<ScriptHost | null>(null);
  const enabled = bindings.size > 0;

  // 宿主单例（页面实例生命周期内复用池位）；无绑定时懒初始化彻底跳过
  const ensureHost = React.useCallback((): ScriptHost | null => {
    if (!enabled) return null;
    if (!hostRef.current) {
      hostRef.current = new ScriptHost({
        loadModule: async () => ({}), // 产物经 artifactUrl 由 Worker 自行 import（bootstrap 协议）
        bridge: createRuntimeBridge(store, client),
        createWorker: (): WorkerLike => {
          const handle = createScriptWorker();
          const worker = handle.worker;
          const wrapped: WorkerLike = {
            postMessage: (m: unknown) => worker.postMessage(m),
            terminate: () => handle.dispose(), // 终止同时释放 Blob URL（句柄化）
            addEventListener: (t: 'message', l: (e: { data: unknown }) => void) => worker.addEventListener(t, l),
            removeEventListener: (t: 'message', l: (e: { data: unknown }) => void) => worker.removeEventListener(t, l),
          };
          return wrapped;
        },
        // ⚠️ 必须绝对 URL：Worker 从 blob: URL 启动，import() 的解析基是 blob URL，
        // 相对路径 '/api/...' 会解析为 blob:http://host/api/... 直接失败（ready ok:false）。
        // API 前缀与请求层同源真源 VITE_API_BASE（验收面 /accept 构建注入——产物路由
        // 必须与数据请求同域；location.origin 裸拼会把验收面产物打到生产 /api）。
        artifactUrl: (hash: string) => `${location.origin}${import.meta.env.VITE_API_BASE ?? ''}/api/build/artifacts/current/${hash}.js`,
        staticPage: {
          params: { pageId: String(page.id) },
          query: Object.fromEntries(new URLSearchParams(location.search)),
          mode: recordId != null ? 'edit' : 'create',
        },
        warnMs: 500,
        hardMs: 10_000,
      });
    }
    return hostRef.current;
  }, [enabled, store, client, page.id, recordId]);

  // 页面卸载 dispose：终止在途调用 + 释放池位（08FE §4.3「防僵尸」）
  React.useEffect(() => () => {
    hostRef.current?.dispose();
    hostRef.current = null;
  }, []);

  const run = React.useCallback(async (hook: HookName, payload: unknown): Promise<HookResult> => {
    const host = ensureHost();
    if (!host) return { ok: true, skipped: true, durationMs: 0 };
    return host.run(hook, payload, bindings);
  }, [ensureHost, bindings]);

  // onFieldChange 50ms 节流（08FE §4.3：快速输入不逐击调度 Worker；尾沿保证最终值必达）
  const pendingField = React.useRef<{ key: string; value: unknown } | null>(null);
  const throttleTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasFieldChangeHook = bindings.has('onFieldChange');
  const notifyFieldChange = React.useCallback((fieldKey: string, value: unknown): void => {
    if (!hasFieldChangeHook) return;
    pendingField.current = { key: fieldKey, value };
    if (throttleTimer.current != null) return; // 已有待发定时器——只更新待发值（尾沿合并）
    throttleTimer.current = setTimeout(() => {
      throttleTimer.current = null;
      const p = pendingField.current;
      pendingField.current = null;
      if (p) void run('onFieldChange', { fieldKey: p.key, value: p.value, values: undefined });
    }, 50);
  }, [hasFieldChangeHook, run]);
  React.useEffect(() => () => {
    if (throttleTimer.current != null) clearTimeout(throttleTimer.current);
  }, []);

  return React.useMemo(() => ({
    enabled,
    // 挂载完成（08FE §4.3 调度点）
    onLoad: () => run('onLoad', { pageId: page.id, recordId: recordId ?? null }),
    beforeSubmit: (payload) => run('beforeSubmit', payload),
    afterSubmit: (payload) => run('afterSubmit', payload),
    onActionClick: (actionKey) => run('onActionClick', { actionKey }),
    notifyFieldChange,
    hasFieldChangeHook,
  }), [enabled, run, page.id, recordId, notifyFieldChange, hasFieldChangeHook]);
}
