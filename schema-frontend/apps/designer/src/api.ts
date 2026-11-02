/**
 * designer 请求层（M11 工作台；v0.4 Cookie 通道）：登录 + 应用/成员/导航/发布 API。
 * 认证走 HttpOnly Cookie（schema_at 自动携带）；状态变更请求注入 X-CSRF-Token 双提交头。
 */
import { authHeaders, initCsrf, login as sdkLogin } from '@schema/auth-sdk';

export class ApiClient {
  constructor(private readonly baseUrl: string = import.meta.env.VITE_API_BASE ?? '') {}

  /** 匿名 csrf 初始化（登录页加载即调——登录 CSRF 防护）。 */
  async initCsrf(): Promise<void> {
    return initCsrf(this.baseUrl);
  }

  async login(account: string, password: string): Promise<void> {
    await sdkLogin(this.baseUrl, { account, password });
  }

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const doFetch = (): Promise<Response> => fetch(`${this.baseUrl}${path}`, {
      method,
      credentials: 'same-origin',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let resp = await doFetch();
    // csrf 403 自动重试一次（07FE §5：多标签并发刷新后旧 csrf 被滚动——拉新值重试仅一次）
    if (resp.status === 403) {
      const raw = await resp.clone().json().catch(() => ({}));
      if ((raw as { code?: string }).code === 'CSRF_TOKEN_REJECTED') {
        await fetch(`${this.baseUrl}/api/auth/csrf`, { credentials: 'same-origin' });
        resp = await doFetch();
      }
    }
    if (resp.status === 401) {
      throw new ApiError('UNAUTHORIZED', '登录已过期，请重新登录');
    }
    if (!resp.ok) {
      const raw = await resp.json().catch(() => ({}));
      const err = raw as { code?: string; message?: string };
      throw new ApiError(err.code ?? `HTTP_${resp.status}`, err.message ?? `请求失败 (${resp.status})`);
    }
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  }

  // ---------- 应用（13BE §A.1） ----------

  listApps(keyword?: string, includeArchived = false): Promise<{ list: AppCard[] }> {
    const q = new URLSearchParams();
    if (keyword) q.set('keyword', keyword);
    if (includeArchived) q.set('includeArchived', 'true');
    const qs = q.toString();
    return this.req('GET', `/api/apps${qs ? `?${qs}` : ''}`) as Promise<{ list: AppCard[] }>;
  }

  createApp(name: string, description?: string): Promise<{ appId: number }> {
    return this.req('POST', '/api/apps', { name, description }) as Promise<{ appId: number }>;
  }

  appDetail(appId: number): Promise<AppDetail> {
    return this.req('GET', `/api/apps/${appId}`) as Promise<AppDetail>;
  }

  updateApp(appId: number, body: { name?: string; description?: string; theme?: string }): Promise<null> {
    return this.req('PUT', `/api/apps/${appId}`, body) as Promise<null>;
  }

  archiveApp(appId: number): Promise<null> {
    return this.req('POST', `/api/apps/${appId}/archive`) as Promise<null>;
  }

  restoreApp(appId: number): Promise<null> {
    return this.req('POST', `/api/apps/${appId}/restore`) as Promise<null>;
  }

  /** 删除预检查（13BE §3.1 P1）：影响面清单 + 确认要求（输入完整应用名）。 */
  deletePrecheck(appId: number): Promise<{ appId: number; impact: Record<string, unknown>; confirmField: string }> {
    return this.req('POST', `/api/apps/${appId}/delete-precheck`) as Promise<{
      appId: number; impact: Record<string, unknown>; confirmField: string;
    }>;
  }

  deleteApp(appId: number, confirmValue: string): Promise<null> {
    return this.req('DELETE', `/api/apps/${appId}`, { confirmValue }) as Promise<null>;
  }

  // ---------- 成员（13BE §A.2） ----------

  listMembers(appId: number): Promise<{ list: MemberRow[] }> {
    return this.req('GET', `/api/apps/${appId}/members`) as Promise<{ list: MemberRow[] }>;
  }

  addMember(appId: number, userId: number, roles: string[]): Promise<null> {
    return this.req('POST', `/api/apps/${appId}/members`, { userId, roles }) as Promise<null>;
  }

  updateMember(appId: number, userId: number, roles: string[]): Promise<null> {
    return this.req('PUT', `/api/apps/${appId}/members/${userId}`, { roles }) as Promise<null>;
  }

  removeMember(appId: number, userId: number): Promise<null> {
    return this.req('DELETE', `/api/apps/${appId}/members/${userId}`) as Promise<null>;
  }

  // ---------- 导航（13BE §A.2） ----------

  getNav(appId: number): Promise<{ tree: NavNode[]; version: number }> {
    return this.req('GET', `/api/apps/${appId}/nav`) as Promise<{ tree: NavNode[]; version: number }>;
  }

  saveNav(appId: number, tree: NavNode[], version: number): Promise<{ version: number }> {
    return this.req('PUT', `/api/apps/${appId}/nav`, { tree, version }) as Promise<{ version: number }>;
  }

  // ---------- 页面与发布（04BE §A.1/§A.2——转发 page-service 口径） ----------

  listPages(appId: number): Promise<{ list: PageRow[] }> {
    return this.req('GET', `/api/pages?appId=${appId}`) as Promise<{ list: PageRow[] }>;
  }

  listReleases(appId: number): Promise<{ list: ReleaseRow[] }> {
    return this.req('GET', `/api/apps/${appId}/releases`) as Promise<{ list: ReleaseRow[] }>;
  }

  publish(appId: number, changelog?: string): Promise<unknown> {
    return this.req('POST', `/api/apps/${appId}/publish`, { changelog });
  }
}

export class ApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export interface AppCard {
  id: number;
  name: string;
  icon: number | null;
  description: string | null;
  myRole: string[];
  status: string;
  navVersion?: number;
}

export interface AppDetail {
  id: number;
  name: string;
  icon: number | null;
  description: string | null;
  theme: string | null;
  navVersion: number;
  status: string;
}

export interface MemberRow {
  userId: number;
  name: string | null;
  account: string | null;
  roles: string[];
}

export interface NavNode {
  id: string;
  type: 'PAGE' | 'GROUP' | 'LINK';
  label: string;
  refId?: number;
  url?: string;
  children?: NavNode[];
}

export interface PageRow {
  id: number;
  pageKey: string;
  name: string;
  status?: string;
}

export interface ReleaseRow {
  releaseId?: number;
  version: number;
  operator?: number | string;
  releasedAt?: string;
}