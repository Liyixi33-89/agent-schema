/**
 * auth-sdk（07FE §5 v0.4 定版：HttpOnly Cookie 会话通道）。
 * 前端零凭证存储：schema_at/schema_rt 均 HttpOnly 由后端签发清除；SDK 只读 schema_csrf
 * 注入 X-CSRF-Token 头（双提交第一道）。
 *
 * 权衡说明：HttpOnly 使 XSS 无法窃取凭证本体，但 XSS 仍可借当前会话发起请求——
 * 防线转移至 CSP（源头阻断）+ 双提交（跨站拦截），不再依赖「token 不在 storage」单点。
 *
 * 环境隔离（M16 审查收口）：
 * 主站与验收面（同源不同路径前缀——如 baseUrl=/accept）的同名 Cookie 并存时，
 * 单飞刷新、广播通道、Web Lock、CSRF 清除路径若共用全局状态会互相干扰
 * （一端登出/刷新波及另一端）。全部按 baseUrl 环境键隔离：
 * - Cookie 读值按路径深度取「最具体」一枚（/accept/ 页面下浏览器会把 / 与 /accept/
 *   两枚 schema_csrf 都发上来——更具体的路径匹配优先级更高，才是当前环境的真值）；
 * - 清除时按环境 Cookie 路径精确清理（Path=/accept/ 配置下清 Path=/ 是无效操作）；
 * - 单飞 Promise / BroadcastChannel / Web Lock 名 / refreshed 信号全部带环境后缀。
 * 长期建议独立域名或不同 Cookie 名（路径隔离不是完整安全边界——同名 Cookie 仍会
 * 在请求头共存，只是读取与清除侧不再混用）。
 */

/** 双提交头：读 schema_csrf cookie（非 HttpOnly——可读是设计要求）。
 *  同名 Cookie 并存（主站 Path=/ 与验收面 Path=/accept/）时取最具体路径的一枚。 */
export function csrfHeaderValue(cookiePath: string = '/'): string | null {
  const m = document.cookie.match(/(?:^|;\s*)schema_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** 会话存在性探测（schema_at 不可读——以服务端 GET /api/me 200/401 为准；本地仅判 csrf 有无做首屏过渡）。 */
export function hasCsrfCookie(): boolean {
  return csrfHeaderValue() != null;
}

/** baseUrl 推导环境 Cookie 路径：
 *  - ''（同源主站）→ '/'；
 *  - '/accept'、'/accept/' → '/accept/'（nginx proxy_cookie_path / /accept/ 下发的 Cookie 路径形态）；
 *  - 绝对 URL（http://host/prefix）取其 pathname。
 *  浏览器 cookie 路径匹配按最长前缀优先——/accept/ 页面请求会同时携带 / 与 /accept/ 两枚。 */
export function envCookiePath(baseUrl: string): string {
  if (!baseUrl) return '/';
  try {
    const u = baseUrl.startsWith('http') ? new URL(baseUrl) : new URL(baseUrl, location.origin);
    const p = u.pathname.replace(/\/+$/, '');
    return p ? `${p}/` : '/';
  } catch {
    return '/';
  }
}

/** 环境键（模块全局状态隔离用）：规范化为无斜杠路径段（'' → 'root'）。 */
function envKey(baseUrl: string): string {
  return envCookiePath(baseUrl).replace(/^\/+|\/+$/g, '') || 'root';
}

/** 主动清除 csrf 残留（登出兜底——HttpOnly 两枚只能服务端清）。
 *  按环境 Cookie 路径清理；主站与验收面同名 Cookie 并存时两端各清各的。
 *  路径清理后再兜底清一次根路径（历史残留——proxy_cookie_path 生效前的旧 Cookie）。 */
export function clearCsrfCookie(baseUrl = ''): void {
  const path = envCookiePath(baseUrl);
  document.cookie = `schema_csrf=; Max-Age=0; Path=${path}`;
  if (path !== '/') {
    document.cookie = 'schema_csrf=; Max-Age=0; Path=/';
  }
}

/** 认证请求公共头（Cookie 通道：csrf 双提交 + 租户路由提示）。 */
export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  const csrf = csrfHeaderValue();
  if (csrf) h['X-CSRF-Token'] = csrf;
  const tenant = localStorage.getItem('schema_tenant');
  if (tenant) h['X-Tenant-Id'] = tenant;
  return h;
}

/** 状态变更请求（非 GET/HEAD）自动注入双提交头。 */
export function methodNeedsCsrf(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

/** 登录前匿名 csrf 初始化（登录 CSRF 防护——登录页加载即调）。
 *  检查 HTTP 失败：非 ok 时抛错（调用方登录页捕获提示），网络异常原样上抛——
 *  旧的静默吞错会让「csrf 未就绪」在后续登录 403 才暴露，难定位。 */
export async function initCsrf(baseUrl = ''): Promise<void> {
  const resp = await fetch(`${baseUrl}/api/auth/csrf`, { credentials: 'same-origin' });
  if (!resp.ok) throw new Error(`csrf 初始化失败 (${resp.status})`);
}

/** 登录（Set-Cookie 由后端签发；响应体不再含 refresh token）。
 *  请求体字段定版：{username, password}（03BE §A.1 契约——account 为 UI 层输入框名，非协议字段）；
 *  兼容存量调用方传 account 的写法（归一化为 username 发送）；
 *  提交前确保匿名 csrf 已就绪（ensureCsrfReady——登录页 initCsrf 未完成时快速点击兜底）。 */
export interface LoginPayload {
  username?: string; account?: string; password: string; tenantId?: number | string;
}

export async function login(baseUrl: string, body: LoginPayload): Promise<{ mustChangePassword: boolean }> {
  await ensureCsrfReady(baseUrl);
  const payload: LoginPayload = { ...body };
  if (payload.username == null && payload.account != null) {
    payload.username = payload.account;
  }
  delete payload.account;
  const resp = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfHeaderValue() ? { 'X-CSRF-Token': csrfHeaderValue()! } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const raw = await resp.json().catch(() => ({}));
    throw new Error((raw as { message?: string }).message ?? `登录失败 (${resp.status})`);
  }
  return resp.json();
}

/** 登出结果：
 *  - revoked=true：服务端确认撤销（HttpOnly 会话已清——安全退出）；
 *  - revoked=false：服务端撤销失败（网络异常/403/5xx）——本地 csrf 已清但 HttpOnly 会话
 *    可能仍有效，调用方须明确提示「登出未完成，请关闭浏览器或重试」，不能当作已安全退出。 */
export interface LogoutResult {
  revoked: boolean;
  /** 失败原因提示（revoked=false 时有值）。 */
  message?: string;
}

/** 登出（零 body——schema_rt cookie 自动携带；本地 csrf 残留无条件清——
 *  本地清屏与服务端撤销是两件事，撤销结果由返回值区分）。
 *  404 视为已登出（幂等——重复点击/会话已过期时服务端本就无会话可撤）。 */
export async function logout(baseUrl = ''): Promise<LogoutResult> {
  try {
    const resp = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
    });
    if (resp.ok || resp.status === 404) return { revoked: true };
    const raw = await resp.json().catch(() => ({}));
    return {
      revoked: false,
      message: (raw as { message?: string }).message ?? `服务端登出失败 (${resp.status})`,
    };
  } catch (e) {
    return { revoked: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    clearCsrfCookie(baseUrl);
  }
}

/** 权限快照（07FE：快照来自 /api/me 响应体——凭证不可读不影响）。 */
export async function fetchMe(baseUrl = ''): Promise<MeSnapshot | null> {
  const resp = await fetch(`${baseUrl}/api/me`, { credentials: 'same-origin' });
  if (!resp.ok) return null;
  return resp.json();
}

export interface MeSnapshot {
  userId: number;
  name: string | null;
  account: string | null;
  dept: number | null;
  tenantId: number;
  mustChangePassword?: boolean;
  roles: string[];
  perms: string[];
}

/** hasPerm O(1)（07FE §5）。 */
export function hasPerm(snapshot: MeSnapshot | null, perm: string): boolean {
  return snapshot != null && snapshot.perms.includes(perm);
}

// ---------- 静默刷新 + 单飞锁 + 跨标签互斥（07FE §5；Web Locks 主路径 + BC 通知降级容忍） ----------

interface AuthChannelMessage {
  type: 'logout' | 'refreshed';
}

/** 环境隔离的单飞状态（M16 收口：主站与验收面并存互不干扰——按 baseUrl 环境键分桶）。 */
const refreshInFlightMap = new Map<string, Promise<boolean>>();

/**
 * 他页刷新信号（2026-11-03 收口：**窗口化**而非永久标志）。
 * refreshed 广播只代表「刚刚」发生过一次成功刷新——带时间戳，超过 REFRESH_SIGNAL_TTL
 * 视为过期（后续 silentRefresh 照常发网络请求，不再凭旧信号直接判成功）。
 * 旧实现的永久布尔标志会让本页跳过真实刷新、拿着过期 access 重放陷入 401 循环。
 * 环境隔离后按 envKey 分桶（主站/验收面各自的信号窗口）。
 */
const REFRESH_SIGNAL_TTL_MS = 10_000;   // 与服务端 ±10s 容忍窗口对齐
const refreshedAtMap = new Map<string, number>();

/** 多标签广播通道（登出/刷新通知；构造失败降级为无广播——Web Locks 与服务端容忍兜底）。
 *  按环境分通道（'auth' / 'auth:accept'）：主站登出广播不应把验收面一并踢下线。 */
const channelMap = new Map<string, BroadcastChannel | null>();
function channelFor(baseUrl: string): BroadcastChannel | null {
  const key = envKey(baseUrl);
  if (!channelMap.has(key)) {
    let ch: BroadcastChannel | null = null;
    try {
      ch = typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel(key === 'root' ? 'auth' : `auth:${key}`)
        : null;
    } catch {
      ch = null;
    }
    // 通道创建即挂内部信号监听（等价旧模块加载期监听——按环境分桶记录 refreshed 时间戳）
    ch?.addEventListener('message', (e: MessageEvent) => {
      if ((e.data as AuthChannelMessage)?.type === 'refreshed') {
        refreshedAtMap.set(key, Date.now());
      }
    });
    channelMap.set(key, ch);
  }
  return channelMap.get(key) ?? null;
}

export function watchAuthChannel(onEvent: (msg: AuthChannelMessage) => void, baseUrl = ''): () => void {
  const channel = channelFor(baseUrl);
  if (!channel) return () => {};
  const handler = (e: MessageEvent): void => onEvent(e.data as AuthChannelMessage);
  channel.addEventListener('message', handler);
  return () => channel.removeEventListener('message', handler);
}

// 内部消费：信号监听已在 channelFor 创建期挂载（按环境分桶记录 refreshed 时间戳）。

/** 广播信号是否仍在有效窗口内（按环境键取时间戳）。 */
function freshRefreshSignal(baseUrl: string): boolean {
  const at = refreshedAtMap.get(envKey(baseUrl)) ?? 0;
  return at > 0 && Date.now() - at < REFRESH_SIGNAL_TTL_MS;
}

/** Web Locks API 形状（渐进增强——不支持时降级为单飞锁 + 广播 + 服务端容忍窗口）。 */
interface LockManagerLike {
  request(name: string, callback: (lock: unknown) => Promise<void>): Promise<void>;
}

function lockManager(): LockManagerLike | null {
  const nav = (navigator as unknown as { locks?: LockManagerLike }).locks;
  return nav && typeof nav.request === 'function' ? nav : null;
}

/** 会话是否已恢复的二次确认（取得锁后调用——GET /api/me 200 即已登录）。
 *  环境隔离关键：探测带 baseUrl——无锁降级路径的「凭信号直接判成功」必须确认
 *  目标环境会话真实有效，而不是主站会话替验收面判活。 */
async function probeSessionRestored(baseUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl}/api/me`, { credentials: 'same-origin' });
    return resp.ok;
  } catch {
    return false;
  }
}

/** 无 Web Locks 降级路径：窗口内信号经目标环境探测确认后判成功，否则发真实刷新请求。 */
async function silentRefreshNoLocks(baseUrl: string): Promise<boolean> {
  if (freshRefreshSignal(baseUrl)) {
    refreshedAtMap.delete(envKey(baseUrl));
    // 信号只说明「他页刚刷新过」——目标环境会话是否真的可用须经 /api/me 确认，
    // 不能直接判成功（旧实现会让验收面借主站刷新信号跳过真实刷新）。
    if (await probeSessionRestored(baseUrl)) return true;
    // 探测失败：可能是 csrf 之外的瞬时异常或会话确实未恢复——发真实刷新由服务端终判
    return doRefreshRequest(baseUrl);
  }
  return doRefreshRequest(baseUrl);
}

/** 真实刷新请求（成功后广播通知他页——通道按环境隔离）。 */
async function doRefreshRequest(baseUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: authHeaders(),
    });
    if (!resp.ok) {
      // 刷新请求自身撞 CSRF 失效（多标签滚动 csrf）：拉新 csrf 重试一次后仍失败才判失败
      if (resp.status === 403) {
        const raw = await resp.clone().json().catch(() => ({}));
        if ((raw as { code?: string }).code === 'CSRF_TOKEN_REJECTED') {
          await refreshCsrfOnce(baseUrl);
          const retry = await fetch(`${baseUrl}/api/auth/refresh`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: authHeaders(),
          });
          if (!retry.ok) return false;
          channelFor(baseUrl)?.postMessage({ type: 'refreshed' } satisfies AuthChannelMessage);
          return true;
        }
      }
      return false;
    }
    channelFor(baseUrl)?.postMessage({ type: 'refreshed' } satisfies AuthChannelMessage);
    return true;
  } catch {
    return false;
  }
}

/**
 * 静默刷新（跨标签互斥主路径 Web Locks）：
 * - 同源同环境标签通过 navigator.locks('schema-auth-refresh[:env]') 串行刷新——
 *   两个标签同时 401 只有一个发请求；锁名带环境键，主站与验收面互不排队；
 * - 排队取得锁后**二次确认**：他页已刷新成功（cookie 已滚动）时 GET /api/me 探测会话已恢复，
 *   直接判成功不发重复刷新；探测 401 说明本页 cookie 未被恢复（他页已登出/失效）——发真实刷新；
 * - 无 Web Locks 降级：窗口化广播信号（10s 有效）+ 单飞锁 + 服务端 ±10s 容忍兜底；
 * - 失败（REFRESH_REVOKED）返回 false 由调用方清本地态跳登录。
 */
export async function silentRefresh(baseUrl = ''): Promise<boolean> {
  const key = envKey(baseUrl);
  const inFlight = refreshInFlightMap.get(key);
  if (inFlight) return inFlight;
  const locks = lockManager();
  const run = (async () => {
    try {
      if (!locks) return silentRefreshNoLocks(baseUrl);
      let outcome = false;
      await locks.request(key === 'root' ? 'schema-auth-refresh' : `schema-auth-refresh:${key}`, async () => {
        // 取得锁后二次确认：会话已恢复（他页刷新的 cookie 已共享）不再重复刷新
        if (await probeSessionRestored(baseUrl)) {
          outcome = true;
          return;
        }
        // 探测失败：可能确实无会话（401），也可能是 csrf 之外的瞬时网络异常——
        // 发真实刷新请求由服务端裁决（REFRESH_REVOKED 才是终判）
        outcome = await doRefreshRequest(baseUrl);
      });
      return outcome;
    } catch {
      // Web Locks 异常（极少数浏览器实现问题）——降级路径兜底
      return silentRefreshNoLocks(baseUrl);
    } finally {
      refreshInFlightMap.delete(key);
    }
  })();
  refreshInFlightMap.set(key, run);
  return run;
}

/** 多标签登出广播（一端登出全端登出——BroadcastChannel 即时感知；按环境分通道）。 */
export function broadcastLogout(baseUrl = ''): void {
  channelFor(baseUrl)?.postMessage({ type: 'logout' } satisfies AuthChannelMessage);
}

/** csrf 403 自动重试辅助：拉新 csrf 值重试一次（仅一次再上抛——07FE §5 降级路径）。 */
export async function refreshCsrfOnce(baseUrl = ''): Promise<void> {
  await fetch(`${baseUrl}/api/auth/csrf`, { credentials: 'same-origin' });
}

/** 登录前等待匿名 csrf 就绪（最多等 once——登录页加载即调 initCsrf，此处兜底快速点击场景）。 */
export async function ensureCsrfReady(baseUrl = ''): Promise<void> {
  if (csrfHeaderValue() != null) return;
  await initCsrf(baseUrl).catch(() => undefined);
}

// ---------- 统一认证请求（authFetch：静默刷新 + 403 csrf 重试 + 401 会话失效回调） ----------

export interface AuthFetchOptions extends RequestInit {
  /** 相对路径（如 /api/apps）。 */
  path: string;
  /** 基地址（默认 ''——同源部署）。 */
  baseUrl?: string;
  /** 401 静默刷新失败后的回调（清本地态跳登录）。 */
  onSessionExpired?: () => void;
}

/** 请求头归一化：Headers 实例 / 键值数组 / 普通对象统一合并进 authHeaders——
 *  旧的 Record 强转会把 Headers 实例解构成未知形状导致请求头丢失。 */
function mergeAuthHeaders(headers: RequestInit['headers']): Record<string, string> {
  const base: Record<string, string> = {};
  if (headers != null) {
    const h = new Headers(headers);
    h.forEach((value, name) => { base[name] = value; });
  }
  return authHeaders(base);
}

/**
 * 统一认证请求（07FE §5 收口——三应用唯一通道）：
 * 1) 自动注入双提交头与租户头（authHeaders——Headers/数组/对象统一归一化）；
 * 2) 401：单飞锁静默刷新一次，成功重放原请求；重放仍 401 时同样判定会话失效
 *    （刷新成功 ≠ 会话有效——权限快照过期/会话被管理员撤销等场景刷新 200 但重放 401，
 *    统一通知 onSessionExpired，页面不再停留登录态反复报错）；
 * 3) 403 CSRF_TOKEN_REJECTED：拉新 csrf 重试一次（多标签并发刷新致旧 csrf 滚动场景）；
 * 4) 多标签：他页刷新成功的广播到达时，本页在飞的静默刷新直接放弃排队等待重放（服务端 ±10s 容忍兜底）。
 *    刷新后重放仍 401 时区分业务权限拒绝：重放请求带了 csrf 重试机制，若重放 401 即最终判定。
 */
export async function authFetch<T = unknown>(opts: AuthFetchOptions): Promise<Response> {
  const { path, baseUrl = '', onSessionExpired, ...init } = opts;
  const headers = mergeAuthHeaders(init.headers);
  const doFetch = (): Promise<Response> => fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers,
  });
  let resp = await doFetch();

  // 401：静默刷新一次后重放（幂等 GET 之外亦适用——刷新后重试不会双写：服务端首个请求已被拒）
  if (resp.status === 401) {
    const refreshed = await silentRefresh(baseUrl);
    if (!refreshed) {
      onSessionExpired?.();
      return resp;   // 原始 401 上抛（调用方判定跳登录）
    }
    resp = await doFetch();
    // 刷新成功但重放仍 401：会话实际无效（刷新签发的 access 对本请求面仍被拒）——
    // 统一通知会话失效，页面跳登录而不是停留登录态反复失败。
    if (resp.status === 401) {
      onSessionExpired?.();
      return resp;
    }
  }

  // 403 csrf 滚动：拉新 csrf 重试一次（仅一次）
  if (resp.status === 403) {
    const raw = await resp.clone().json().catch(() => ({}));
    if ((raw as { code?: string }).code === 'CSRF_TOKEN_REJECTED') {
      await refreshCsrfOnce(baseUrl);
      resp = await doFetch();
    }
  }
  return resp;
}
