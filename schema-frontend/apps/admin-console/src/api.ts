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

/**
 * 请求错误（携带 HTTP 状态码与后端业务码）：
 * 权限判定必须依据 status，不能靠文案是否包含 "403"——后端返回「无权限」等业务文案时
 * 文案匹配会漏判，真正的 403 也可能被当成普通加载失败。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** 统一请求：非 2xx 抛 ApiError（携带 status/code）；401 显式提示重新登录。 */
export async function req(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const resp = await authFetch({
    path,
    baseUrl: BASE,
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    onSessionExpired: () => onSessionExpired?.(),
  });
  if (resp.status === 401) throw new ApiError('登录已过期，请重新登录', 401);
  if (!resp.ok) {
    const raw = await resp.json().catch(() => ({}));
    const message = (raw as { message?: string }).message ?? `请求失败 (${resp.status})`;
    const code = (raw as { code?: string }).code ?? null;
    throw new ApiError(message, resp.status, code);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

/** 错误文案提取归集至 @schema/shared-ui（第三阶段）——保持原路径 re-export，调用面零改动。 */
export { errOf } from '@schema/shared-ui';

/** 后端 403 判定（按状态码，不匹配文案——无权限提示与网络错误区分展示）。 */
export function isForbidden(e: unknown): boolean {
  if (e instanceof ApiError) return e.status === 403;
  // 兜底：非本层抛出的错误对象若显式带 status=403 也认（不读文案）
  return typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 403;
}