/**
 * 应用内共享异步能力（跨 feature 复用——asyncMachine 纯函数 + AsyncController 调度 + useAsyncData Hook）。
 * 其他 feature 只能经本文件引用，不得深路径导入内部文件。
 */
export {
  ASYNC_INIT, begin, fail, isAbortError, reset, shouldAccept, succeed,
  type AsyncState,
} from './asyncMachine';
export { AsyncController, type AsyncControllerOptions } from './asyncController';
export { useAsyncData, HEALTH_POLL_MS } from './useAsyncData';