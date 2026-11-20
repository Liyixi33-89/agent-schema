/**
 * 异步状态机（纯函数——阶段 C 范例核心）：
 * 状态迁移策略全部下沉为可单测纯函数；useAsyncData 壳只做调度（定时器/请求发起/取消）。
 *
 * 六态区分：
 * - loading    初次加载（尚无任何数据）
 * - refreshing 已有数据时的刷新中（旧数据保留展示，但必须标明「刷新中」）
 * - data       成功数据（空数组/空对象是合法「无样本」态）
 * - error      请求失败或响应契约校验失败
 * - forbidden  403（页面级权限引导，区别于网络失败）
 * - stale      已有数据时的刷新失败（旧数据保留，但必须提示非最新）
 *
 * 恢复策略（明确、非粘性）：forbidden 只反映**最近一次**请求结果——
 * 403 之后的普通失败会清除 forbidden（此时已无法确认是权限问题，按普通错误展示）；
 * 成功则清除全部错误标记。避免「403 后一直显示无权限」的粘性误导。
 */
import { errOf, isForbidden } from '../../api';

export interface AsyncState<T> {
  /** 初次加载中（尚未有任何数据）。 */
  loading: boolean;
  /** 已有数据时的刷新中（旧数据保留，页面应标明刷新状态）。 */
  refreshing: boolean;
  /** 成功数据（null=尚未成功过）；空数组/空对象仍是合法「无样本」态。 */
  data: T | null;
  /** 请求失败或契约校验失败文案（初次失败或刷新失败均记录）。 */
  error: string | null;
  /** 无权限（403——页面级引导，区别于网络失败）。 */
  forbidden: boolean;
  /** 已有数据时的刷新失败（旧数据保留展示，但必须提示非最新）。 */
  stale: boolean;
}

export const ASYNC_INIT: AsyncState<never> = {
  loading: true, refreshing: false, data: null, error: null, forbidden: false, stale: false,
};

/** 查询身份变化（月份/租户等）→ 完全重置：旧数据属于另一个查询，不得继续展示。 */
export function reset<T>(): AsyncState<T> {
  return { loading: true, refreshing: false, data: null, error: null, forbidden: false, stale: false };
}

/** 相同查询刷新（轮询/手动重试）→ 保留旧数据；有数据时标 refreshing，无数据时标 loading。 */
export function begin<T>(prev: AsyncState<T>): AsyncState<T> {
  return {
    ...prev,
    loading: prev.data === null,
    refreshing: prev.data !== null,
    stale: false,
  };
}

/** 成功迁移：清错误/权限/过期/刷新标记。 */
export function succeed<T>(prev: AsyncState<T>, data: T): AsyncState<T> {
  return { loading: false, refreshing: false, data, error: null, forbidden: false, stale: false };
}

/** 失败迁移：403 → forbidden（非粘性）；已有数据保留并标记 stale（不当最新）。 */
export function fail<T>(prev: AsyncState<T>, e: unknown): AsyncState<T> {
  const forbidden = isForbidden(e);
  return {
    loading: false,
    refreshing: false,
    error: forbidden ? null : errOf(e),
    forbidden,
    data: prev.data,                          // 旧数据保留
    stale: prev.data !== null && !forbidden,  // 有旧数据且非权限问题 → 非最新标记
  };
}

/** 请求被取消（AbortError）——不是失败，不得迁移状态。 */
export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

/**
 * 响应落地闸门（竞态 + 卸载收口）：
 * 仅当响应序号仍是最新且组件未卸载才允许迁移——旧请求晚回/卸载后晚回一律丢弃。
 */
export function shouldAccept(latestSeq: number, responseSeq: number, alive: boolean): boolean {
  return alive && responseSeq === latestSeq;
}