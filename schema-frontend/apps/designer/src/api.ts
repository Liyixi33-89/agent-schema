/**
 * designer 请求层（M11 工作台；v0.4 Cookie 通道）：登录 + 应用/成员/导航/发布 API。
 * 认证走 HttpOnly Cookie（schema_at 自动携带）；统一走 authFetch（静默刷新 + 403 csrf 重试）。
 */
import { authFetch, initCsrf, login as sdkLogin } from '@schema/auth-sdk';

export class ApiClient {
  /** 401 刷新失败回调（main.tsx 注入——清本地态回登录页）。 */
  static onSessionExpired: (() => void) | null = null;

  constructor(private readonly baseUrl: string = import.meta.env.VITE_API_BASE ?? '') {}

  /** 匿名 csrf 初始化（登录页加载即调——登录 CSRF 防护）。 */
  async initCsrf(): Promise<void> {
    return initCsrf(this.baseUrl);
  }

  async login(account: string, password: string): Promise<void> {
    await sdkLogin(this.baseUrl, { account, password });
  }

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const resp = await authFetch({
      path,
      baseUrl: this.baseUrl,
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      onSessionExpired: () => ApiClient.onSessionExpired?.(),
    });
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

  // ---------- 模型与元数据（01BE §A.1-A.3；X-App-Id 路由应用域） ----------

  private async reqApp(appId: number, method: string, path: string, body?: unknown): Promise<unknown> {
    const resp = await authFetch({
      path, baseUrl: this.baseUrl, method,
      headers: { 'Content-Type': 'application/json', 'X-App-Id': String(appId) },
      body: body === undefined ? undefined : JSON.stringify(body),
      onSessionExpired: () => ApiClient.onSessionExpired?.(),
    });
    if (resp.status === 401) throw new ApiError('UNAUTHORIZED', '登录已过期，请重新登录');
    if (!resp.ok) {
      const raw = await resp.json().catch(() => ({})) as { code?: string; message?: string; details?: unknown };
      const err = new ApiError(raw.code ?? `HTTP_${resp.status}`, raw.message ?? `请求失败 (${resp.status})`) as ApiError & {
        status: number; details: unknown;
      };
      err.status = resp.status;
      err.details = raw.details;
      throw err;
    }
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  }

  listModels(appId: number): Promise<{ list: ModelSummary[]; total: number }> {
    return this.reqApp(appId, 'GET', '/api/models') as Promise<{ list: ModelSummary[]; total: number }>;
  }

  createModel(appId: number, modelKey: string, name: string): Promise<{ id: string; modelKey: string; currentVersion: number }> {
    return this.reqApp(appId, 'POST', '/api/models', { modelKey, name }) as Promise<{ id: string; modelKey: string; currentVersion: number }>;
  }

  modelDetail(appId: number, modelId: string): Promise<ModelDetail> {
    return this.reqApp(appId, 'GET', `/api/models/${modelId}`) as Promise<ModelDetail>;
  }

  /** 两段式保存第一段（01BE §A.2）。 */
  precheck(appId: number, modelId: string, changes: unknown[]): Promise<PrecheckResp> {
    return this.reqApp(appId, 'POST', `/api/models/${modelId}/precheck`, { changes }) as Promise<PrecheckResp>;
  }

  /** 两段式保存第二段：携带 details（serverVersion）的错误透传给状态机。 */
  saveSchema(appId: number, modelId: string, body: {
    changes: unknown[]; baseVersion: number; confirmToken: string; confirmValue?: string;
  }): Promise<{ version: number }> {
    return this.reqApp(appId, 'POST', `/api/models/${modelId}/schema`, body) as Promise<{ version: number }>;
  }

  listVersions(appId: number, modelId: string): Promise<{ list: VersionRow[] }> {
    return this.reqApp(appId, 'GET', `/api/models/${modelId}/versions`) as Promise<{ list: VersionRow[] }>;
  }

  getVersion(appId: number, modelId: string, version: number): Promise<{ version: number; snapshot: { fields?: { fieldKey: string; label: string; type: string; fieldStatus?: string }[] } }> {
    return this.reqApp(appId, 'GET', `/api/models/${modelId}/versions/${version}`) as Promise<{ version: number; snapshot: { fields?: { fieldKey: string; label: string; type: string; fieldStatus?: string }[] } }>;
  }

  rollbackPrecheck(appId: number, modelId: string, targetVersion: number): Promise<PrecheckResp> {
    return this.reqApp(appId, 'POST', `/api/models/${modelId}/rollback/precheck`, { targetVersion }) as Promise<PrecheckResp>;
  }

  rollback(appId: number, modelId: string, body: { targetVersion: number; confirmToken: string; confirmValue?: string }): Promise<{ version: number }> {
    return this.reqApp(appId, 'POST', `/api/models/${modelId}/rollback`, body) as Promise<{ version: number }>;
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

// ---------- 元数据协议镜像（data-model-designer 包复用类型；此处导入避免双定义漂移） ----------

import type {
  ChangeOp, ConfirmMode, ModelDetail, ModelField, ModelSummary, PrecheckResp, Risk, Severity, VersionRow,
} from '@schema/data-model-designer';
export type { ChangeOp, ConfirmMode, ModelDetail, ModelField, ModelSummary, PrecheckResp, Risk, Severity, VersionRow };