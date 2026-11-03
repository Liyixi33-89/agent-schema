/**
 * auth-sdk 单测（07FE §6 硬性要求——Cookie 通道专项）：
 * 登录字段归一化（account→username）/ 双提交注入 / 401 单飞静默刷新重放 /
 * 403 CSRF 自动重试 / refreshed 广播消费放弃本地刷新 / onSessionExpired 触发。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- fetch stub（记录调用；按序返回预设响应） ----

type FetchCall = { url: string; init: RequestInit };

let calls: FetchCall[] = [];
let responses: Array<{ status: number; body?: unknown } | null> = [];

function enqueue(status: number, body?: unknown): void {
  responses.push({ status, body });
}

function lastCall(): FetchCall {
  return calls[calls.length - 1];
}

const fetchStub = vi.fn(async (url: string | URL, init?: RequestInit): Promise<Response> => {
  calls.push({ url: String(url), init: init ?? {} });
  const preset = responses.shift() ?? { status: 200, body: {} };
  return {
    ok: preset.status >= 200 && preset.status < 300,
    status: preset.status,
    json: async () => preset.body ?? {},
    text: async () => JSON.stringify(preset.body ?? {}),
    clone() {
      return this;
    },
  } as unknown as Response;
});

// ---- BroadcastChannel stub（默认可用；用例可置 null 模拟降级） ----

class ChannelStub {
  static instances: ChannelStub[] = [];
  listeners: Array<(e: { data: unknown }) => void> = [];
  posted: unknown[] = [];
  constructor() {
    ChannelStub.instances.push(this);
  }
  addEventListener(_t: string, h: (e: { data: unknown }) => void): void {
    this.listeners.push(h);
  }
  removeEventListener(_t: string, h: (e: { data: unknown }) => void): void {
    this.listeners = this.listeners.filter((l) => l !== h);
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  receive(msg: unknown): void {
    for (const l of [...this.listeners]) l({ data: msg });
  }
}

// ---- DOM/localStorage stub ----

let cookieStore: Record<string, string> = {};
let lsStore: Record<string, string> = {};

vi.stubGlobal('fetch', fetchStub);
vi.stubGlobal('BroadcastChannel', ChannelStub);
vi.stubGlobal('document', {
  get cookie(): string {
    return Object.entries(cookieStore).map(([k, v]) => `${k}=${v}`).join('; ');
  },
  set cookie(v: string) {
    const [pair] = v.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    if (v.includes('Max-Age=0')) delete cookieStore[name];
    else cookieStore[name] = value;
  },
});
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => { lsStore[k] = v; },
  removeItem: (k: string) => { delete lsStore[k]; },
});
// navigator：默认无 locks（走降级路径）；Web Locks 用例经 installLocks() 覆盖
vi.stubGlobal('navigator', {});

// 模块级单飞状态在用例间须复位——动态 import 前清空模块缓存
async function freshSdk() {
  const mod = await import('../src/index');
  return mod;
}

/** 可控锁管理器 stub（文件级——多个 describe 共用）：记录请求名并同步执行回调。 */
function installLocks() {
  vi.stubGlobal('navigator', {
    locks: {
      async request(_name: string, cb: () => Promise<void>) {
        await cb();
      },
    },
  });
}

let sdk: Awaited<ReturnType<typeof freshSdk>>;

beforeEach(async () => {
  calls = [];
  responses = [];
  cookieStore = {};
  lsStore = {};
  ChannelStub.instances = [];
  vi.resetModules();
  vi.unstubAllGlobals();   // 清 installLocks/navigator 残留——每用例从干净全局开始
  vi.stubGlobal('fetch', fetchStub);
  vi.stubGlobal('BroadcastChannel', ChannelStub);
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('document', {
    get cookie(): string {
      return Object.entries(cookieStore).map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(v: string) {
      const [pair] = v.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1);
      if (v.includes('Max-Age=0')) delete cookieStore[name];
      else cookieStore[name] = value;
    },
  });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => lsStore[k] ?? null,
    setItem: (k: string, v: string) => { lsStore[k] = v; },
    removeItem: (k: string) => { delete lsStore[k]; },
  });
  sdk = await freshSdk();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('登录字段归一化（03BE §A.1 契约 {username,password}）', () => {
  it('传 account 时归一化为 username 发送，不残留 account 字段', async () => {
    enqueue(200, { mustChangePassword: false });
    await sdk.login('', { account: 'alice', password: 'p' });
    const body = JSON.parse(String(lastCall().init.body));
    expect(body.username).toBe('alice');
    expect('account' in body).toBe(false);
  });

  it('直接传 username 时原样发送', async () => {
    enqueue(200, { mustChangePassword: false });
    await sdk.login('', { username: 'bob', password: 'p' });
    const body = JSON.parse(String(lastCall().init.body));
    expect(body.username).toBe('bob');
  });

  it('携带已存在的 csrf 双提交头', async () => {
    cookieStore['schema_csrf'] = 'tok-1';
    enqueue(200, { mustChangePassword: false });
    await sdk.login('', { username: 'bob', password: 'p' });
    const headers = lastCall().init.headers as Record<string, string>;
    expect(headers['X-CSRF-Token']).toBe('tok-1');
  });
});

describe('authHeaders 双提交与租户头', () => {
  it('有 csrf cookie 时注入头；租户取 localStorage', () => {
    cookieStore['schema_csrf'] = 'tok-2';
    lsStore['schema_tenant'] = '3';
    const h = sdk.authHeaders();
    expect(h['X-CSRF-Token']).toBe('tok-2');
    expect(h['X-Tenant-Id']).toBe('3');
  });

  it('无 csrf cookie 时不注入空头', () => {
    const h = sdk.authHeaders();
    expect('X-CSRF-Token' in h).toBe(false);
  });
});

describe('authFetch 401 单飞刷新重放', () => {
  it('401 → 静默刷新一次 → 重放原请求；并发共享单飞', async () => {
    cookieStore['schema_csrf'] = 'tok';
    // 三个并发请求：各 401 一次；refresh 200；重放 200
    enqueue(401); enqueue(401); enqueue(401);
    enqueue(200); enqueue(200); enqueue(200);
    enqueue(200, { ok: true }); enqueue(200, { ok: true }); enqueue(200, { ok: true });
    const results = await Promise.all([
      sdk.authFetch({ path: '/api/a', method: 'POST' }),
      sdk.authFetch({ path: '/api/b', method: 'POST' }),
      sdk.authFetch({ path: '/api/c', method: 'POST' }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    // refresh 只发一次（单飞锁）
    const refreshCalls = calls.filter((c) => c.url.includes('/api/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
  });

  it('刷新失败触发 onSessionExpired 并原样返回 401', async () => {
    cookieStore['schema_csrf'] = 'tok';
    enqueue(401);       // 业务请求 401
    enqueue(401, { code: 'REFRESH_REVOKED' });   // refresh 失败
    const expired = vi.fn();
    const resp = await sdk.authFetch({ path: '/api/a', method: 'POST', onSessionExpired: expired });
    expect(resp.status).toBe(401);
    expect(expired).toHaveBeenCalledTimes(1);
  });
});

describe('403 CSRF_TOKEN_REJECTED 自动重试', () => {
  it('403 后拉新 csrf 重试一次成功', async () => {
    cookieStore['schema_csrf'] = 'old';
    enqueue(403, { code: 'CSRF_TOKEN_REJECTED' });
    enqueue(200, {});                    // GET /api/auth/csrf 拉新值
    enqueue(200, { ok: true });          // 重放成功
    const resp = await sdk.authFetch({ path: '/api/a', method: 'POST' });
    expect(resp.status).toBe(200);
    expect(calls.some((c) => c.url.includes('/api/auth/csrf'))).toBe(true);
  });

  it('非 CSRF 的 403 不重试直接返回', async () => {
    enqueue(403, { code: 'PERM_DENIED' });
    const resp = await sdk.authFetch({ path: '/api/a', method: 'POST' });
    expect(resp.status).toBe(403);
    expect(calls).toHaveLength(1);
  });
});

describe('多标签 refreshed 广播消费', () => {
  it('他页刷新广播后本页 silentRefresh 直接成功不再发网络请求', async () => {
    ChannelStub.instances[0].receive({ type: 'refreshed' });
    const ok = await sdk.silentRefresh('');
    expect(ok).toBe(true);
    expect(calls).toHaveLength(0);   // 未发 refresh——消费广播即成功
  });

  it('本页刷新成功广播 {type:"refreshed"}', async () => {
    enqueue(200, {});
    const ok = await sdk.silentRefresh('');
    expect(ok).toBe(true);
    expect(ChannelStub.instances[0].posted).toEqual([{ type: 'refreshed' }]);
  });

  it('logout 广播经 watchAuthChannel 触发回调', () => {
    const spy = vi.fn();
    sdk.watchAuthChannel(spy);
    ChannelStub.instances[0].receive({ type: 'logout' });
    expect(spy).toHaveBeenCalledWith({ type: 'logout' });
  });

  it('【窗口化收口】广播信号过期后 silentRefresh 必须发真实请求（旧永久标志致 401 循环）', async () => {
    ChannelStub.instances[0].receive({ type: 'refreshed' });
    // 前进 11s（超过 10s TTL）——旧实现永久标志会继续凭信号判成功
    const now = Date.now;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11_000);
    try {
      enqueue(200, {});   // 真实 refresh 请求成功
      const ok = await sdk.silentRefresh('');
      expect(ok).toBe(true);
      expect(calls.some((c) => c.url.includes('/api/auth/refresh'))).toBe(true);
    } finally {
      vi.spyOn(Date, 'now').mockRestore();
      void now;
    }
  });

  it('【乱序过期】先收过期前的旧广播再刷新：窗口内信号仍有效直接判成功', async () => {
    ChannelStub.instances[0].receive({ type: 'refreshed' });
    enqueue(200, {});
    const ok = await sdk.silentRefresh('');
    expect(ok).toBe(true);
    expect(calls).toHaveLength(0);   // 窗口内信号有效——不发请求
  });
});

describe('Web Locks 跨标签互斥（2026-11-03 收口）', () => {
  it('有 Web Locks 时刷新经锁串行，且锁内先二次确认会话（/api/me 200 即恢复）', async () => {
    installLocks();
    // 二次确认 /api/me 返回 200（他页已刷新、cookie 已共享本页）
    enqueue(200, { userId: 1 });   // GET /api/me
    const ok = await sdk.silentRefresh('');
    expect(ok).toBe(true);
    // 不发 /api/auth/refresh——会话已恢复，锁内直接判成功
    expect(calls.some((c) => c.url.includes('/api/auth/refresh'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/api/me'))).toBe(true);
  });

  it('锁内探测 401（会话未恢复）时发真实刷新请求', async () => {
    installLocks();
    enqueue(401);                  // GET /api/me → 401
    enqueue(200, {});              // POST /api/auth/refresh → 200
    const ok = await sdk.silentRefresh('');
    expect(ok).toBe(true);
    expect(calls.some((c) => c.url.includes('/api/auth/refresh'))).toBe(true);
  });

  it('无 Web Locks（navigator.locks 缺失）降级可用：直接走刷新请求', async () => {
    vi.stubGlobal('navigator', {});
    enqueue(200, {});
    const ok = await sdk.silentRefresh('');
    expect(ok).toBe(true);
    expect(calls.some((c) => c.url.includes('/api/auth/refresh'))).toBe(true);
  });
});

describe('刷新请求自身 CSRF 失效恢复（2026-11-03 收口）', () => {
  it('refresh 撞 403 CSRF_TOKEN_REJECTED：拉新 csrf 重试一次成功并广播', async () => {
    installLocks();
    enqueue(401);                          // /api/me 探测 → 401（会话未恢复）
    enqueue(403, { code: 'CSRF_TOKEN_REJECTED' });   // refresh 第一拍 → csrf 滚动失效
    enqueue(200, {});                      // GET /api/auth/csrf 拉新值
    enqueue(200, {});                      // refresh 重试 → 成功
    const ok = await sdk.silentRefresh('');
    expect(ok).toBe(true);
    expect(calls.filter((c) => c.url.includes('/api/auth/refresh'))).toHaveLength(2);
    expect(ChannelStub.instances[0].posted).toContainEqual({ type: 'refreshed' });
  });

  it('refresh 重试仍失败：返回 false（调用方判会话失效）', async () => {
    installLocks();
    enqueue(401);                          // /api/me → 401
    enqueue(403, { code: 'CSRF_TOKEN_REJECTED' });   // refresh → 403 csrf
    enqueue(200, {});                      // 拉新 csrf
    enqueue(401, { code: 'REFRESH_REVOKED' });       // 重试 → 401 终判
    const ok = await sdk.silentRefresh('');
    expect(ok).toBe(false);
  });

  it('refresh 403 但非 CSRF 码（如越权）：不重试直接失败', async () => {
    installLocks();
    enqueue(401);                          // /api/me → 401
    enqueue(403, { code: 'PERM_DENIED' }); // refresh → 403 非 csrf
    const ok = await sdk.silentRefresh('');
    expect(ok).toBe(false);
    expect(calls.filter((c) => c.url.includes('/api/auth/refresh'))).toHaveLength(1);
  });
});

describe('登录前 CSRF 就绪（ensureCsrfReady——快速点击场景）', () => {
  it('无 csrf cookie 时 login 先等待匿名初始化完成', async () => {
    // login 内部：ensureCsrfReady 先 GET /api/auth/csrf，再 POST login
    enqueue(200, {});   // GET /api/auth/csrf
    enqueue(200, { mustChangePassword: false });   // POST /api/auth/login
    await sdk.login('', { username: 'alice', password: 'p' });
    const csrfCall = calls.find((c) => c.url.includes('/api/auth/csrf'));
    const loginCall = calls.find((c) => c.url.includes('/api/auth/login'));
    expect(csrfCall).toBeTruthy();
    expect(loginCall).toBeTruthy();
    // csrf 初始化先于登录请求发出
    expect(calls.indexOf(csrfCall!)).toBeLessThan(calls.indexOf(loginCall!));
  });

  it('已有 csrf cookie 时不重复初始化直接登录', async () => {
    cookieStore['schema_csrf'] = 'tok-ready';
    enqueue(200, { mustChangePassword: false });
    await sdk.login('', { username: 'alice', password: 'p' });
    expect(calls).toHaveLength(1);   // 只有 login，无 csrf 初始化
    expect((lastCall().init.headers as Record<string, string>)['X-CSRF-Token']).toBe('tok-ready');
  });

  it('csrf 初始化网络失败不阻断登录提交（服务端 Origin 校验兜底）', async () => {
    // GET /api/auth/csrf 抛网络异常 → ensureCsrfReady 吞掉 → login 照常发出
    responses.push(null);   // fetch stub 收到 null 时抛异常的钩子见下
    fetchStub.mockImplementationOnce(async () => { throw new TypeError('network down'); });
    enqueue(200, { mustChangePassword: false });
    await sdk.login('', { username: 'alice', password: 'p' });
    expect(calls.some((c) => c.url.includes('/api/auth/login'))).toBe(true);
  });
});
