/**
 * 管理端请求层（admin-console 内聚——本文件由 main.tsx 原样抽出，行为不变）：
 * - 复用 auth-sdk authFetch（HttpOnly Cookie 通道 + CSRF 双提交 + 401 静默刷新）；
 * - 401 最终失败（刷新链耗尽）回调 onSessionExpired 由入口注入——回登录页语义留在入口；
 * - 本轮重构不迁 request-sdk（保持安全边界：主站/验收隔离、Cookie/Bearer 通道隔离不动）。
 */
import { authFetch } from '@schema/auth-sdk';

const BASE = import.meta.env.VITE_API_BASE ?? '';

/** 401 静默刷新失败回调（入口注入——清本地态回登录页）。 */
let onSessionExpired: (() => void) | null = null;

/** 入口注册会话过期回调（401 刷新链耗尽时触发）。 */
export function setSessionExpiredHandler(fn: (() => void) | null): void {
  onSessionExpired = fn;
}

/** 统一请求：非 2xx 抛业务 message；401 显式提示重新登录。 */
export async function req(method: string, path: string, body?: unknown): Promise<unknown> {
  const resp = await authFetch({
    path,
    baseUrl: BASE,
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    onSessionExpired: () => onSessionExpired?.(),
  });
  if (resp.status === 401) throw new Error('登录已过期，请重新登录');
  if (!resp.ok) {
    const raw = await resp.json().catch(() => ({}));
    throw new Error((raw as { message?: string }).message ?? `请求失败 (${resp.status})`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

/** 错误文案提取归集至 @schema/shared-ui（第三阶段）——保持原路径 re-export，调用面零改动。 */
export { errOf } from '@schema/shared-ui';

/** 后端 403 判定（无权限提示与网络错误区分展示）。 */
export function isForbidden(e: unknown): boolean {
  return e instanceof Error && e.message.includes('403');
}
