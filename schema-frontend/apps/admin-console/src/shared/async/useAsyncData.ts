/**
 * 请求状态 Hook（阶段 C 范例）：调度逻辑全部下沉 asyncController.ts（框架无关、可单测）——
 * 本文件只做 React 装配（state 桥接 + effect 生命周期）。
 *
 * 调度约定：
 * 1. 查询身份变化（deps 变化，如月份/租户）→ 重置状态，不保留旧查询数据；
 * 2. 相同查询刷新（轮询/手动 reload）→ 保留旧数据并标 refreshing；
 * 3. 轮询不重叠（上一次完成后才调度下一次）；
 * 4. 真实取消（依赖变化/卸载/新请求发起时 abort 在途请求）；
 * 5. pollMs 纳入 effect 依赖（周期变化即时生效，且不重置数据）。
 */
import React from 'react';
import { AsyncController } from './asyncController';
import { ASYNC_INIT, reset, type AsyncState } from './asyncMachine';

export type { AsyncState } from './asyncMachine';

/** 轮询周期常量（健康页 30s——与既有行为一致）。 */
export const HEALTH_POLL_MS = 30000;

/**
 * 单区域数据加载 Hook（带竞态/卸载/取消防护）。
 * @param loader 数据获取函数（接收 AbortSignal；契约校验失败应抛错，不得返回 null 冒充成功）
 * @param deps 查询身份依赖（变化即重置并重新加载）
 * @param pollMs 轮询周期（0=不轮询）；上一次完成后才调度下一次，不重叠
 */
export function useAsyncData<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: React.DependencyList,
  pollMs = 0,
): AsyncState<T> & { reload: () => void } {
  const [state, setState] = React.useState<AsyncState<T>>(() => reset<T>());
  const loaderRef = React.useRef(loader);
  loaderRef.current = loader;
  const controllerRef = React.useRef<AsyncController<T> | null>(null);

  // 查询身份序列化（区分「查询变化」与「仅轮询周期变化」）
  const identity = JSON.stringify(deps);

  React.useEffect(() => {
    const controller = new AsyncController<T>({
      loader: (signal) => loaderRef.current(signal),
      onState: (updater) => setState(updater),
      pollMs,
    });
    controllerRef.current = controller;
    controller.start(identity);
    return () => {
      controller.stop();
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, pollMs]);

  const reload = React.useCallback(() => {
    controllerRef.current?.reload();
  }, []);

  return { ...state, reload };
}

/** 初始态导出（供测试与页面默认值使用）。 */
export { ASYNC_INIT };