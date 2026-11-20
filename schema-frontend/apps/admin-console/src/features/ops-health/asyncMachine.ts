/**
 * 异步状态机（纯函数——阶段 C 范例核心）：
 * 状态迁移策略全部下沉为可单测纯函数；useAsyncData 壳只做调度（定时器/请求发起）。
 * 六态区分：loading（初次）/ data（成功，空样本合法）/ error / forbidden(403) /
 * stale（刷新失败保留旧数据）。竞态与卸载判定经 shouldAccept 纯函数收口。
 */
import { errOf, isForbidden } from '../../api';

export interface AsyncState<T> {
  /** 初次加载中（尚未有任何数据）。 */
  loading: boolean;
  /** 成功数据（null=尚未成功过或不可用）；空数组/空对象仍是合法「无样本」态。 */
  data: T | null;
  /** 请求失败文案（初次失败或刷新失败均记录）。 */
  error: string | null;
  /** 无权限（403——页面级引导，区别于网络失败）。 */
  forbidden: boolean;
  /** 已有数据时的刷新失败（旧数据保留展示，但必须提示非最新）。 */
  stale: boolean;
}

export const ASYNC_INIT: AsyncState<never> = { loading: true, data: null, error: null, forbidden: false, stale: false };

/** 请求发起时的状态迁移（初次 loading；已有数据静默刷新中不遮罩）。 */
export function begin<T>(prev: AsyncState<T>): AsyncState<T> {
  return { ...prev, loading: prev.data === null, stale: false };
}

/** 成功迁移：清错误/权限/过期标记。 */
export function succeed<T>(prev: AsyncState<T>, data: T | null): AsyncState<T> {
  return { loading: false, data, error: null, forbidden: false, stale: false };
}

/** 失败迁移：403 → forbidden；已有数据保留并标记 stale（不当最新）。 */
export function fail<T>(prev: AsyncState<T>, e: unknown): AsyncState<T> {
  const forbidden = isForbidden(e);
  return {
    ...prev,
    loading: false,
    error: forbidden ? null : errOf(e),
    forbidden: prev.forbidden || forbidden,
    data: prev.data,                       // 旧数据保留
    stale: prev.data !== null && !forbidden, // 有旧数据且非权限问题 → 非最新标记
  };
}

/**
 * 响应落地闸门（竞态 + 卸载收口）：
 * 仅当响应序号仍是最新且组件未卸载才允许迁移——旧请求晚回/卸载后晚回一律丢弃。
 */
export function shouldAccept(latestSeq: number, responseSeq: number, alive: boolean): boolean {
  return alive && responseSeq === latestSeq;
}
