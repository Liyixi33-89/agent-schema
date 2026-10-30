/**
 * 请求层（M11 最小宿主，02FE §7 DataSourceBinding 消费）：
 * 统一 ID/过滤树/响应包裹/错误结构——表单与列表数据面的唯一通道。
 *
 * 错误映射（03FE §7 服务端校验对齐）：
 * 422 VALIDATION_FAILED → ServerError（字段级错误归位）；
 * 401/403/404/409 → 全局错误；网络异常 → 全局错误。
 */
import { ServerError } from '@schema/schema-form';
import type { FilterNode } from '@schema/schema-protocol';

export interface RequestConfig {
  baseUrl: string;
  /** 认证 token 获取（宿主注入——从 localStorage/预览会话取）。 */
  getToken?: () => string | null;
  /** 租户头（JWT claim 绑定口径）。 */
  getTenantId?: () => string | null;
}

export class RequestClient {
  constructor(private readonly config: RequestConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = this.config.getToken?.();
    if (token) h['Authorization'] = `Bearer ${token}`;
    const tenant = this.config.getTenantId?.();
    if (tenant) h['X-Tenant-Id'] = tenant;
    return h;
  }

  /** 发布页面 Schema 加载（ETag 缓存）。 */
  async loadPage(pageId: string | number, etag?: string | null): Promise<{ schema: unknown; etag: string | null }> {
    const h = this.headers();
    if (etag) h['If-None-Match'] = `"${etag}"`;
    const resp = await fetch(`${this.config.baseUrl}/api/runtime/pages/${pageId}`, { headers: h });
    if (resp.status === 304) return { schema: null, etag: etag ?? null };
    if (resp.status === 404) throw new ServerError('NOT_FOUND', '页面不存在或未发布');
    if (!resp.ok) throw new ServerError('LOAD_FAILED', `页面加载失败 (${resp.status})`);
    return { schema: await resp.json(), etag: resp.headers.get('ETag')?.replace(/^"|"$/g, '') ?? null };
  }

  /** 模型字段元数据（表单构建输入——权限过滤后的可见集，与数据面同源）。 */
  async loadFields(modelId: string | number): Promise<unknown> {
    const resp = await fetch(`${this.config.baseUrl}/api/data/${modelId}/fields`, {
      headers: this.headers(),
    });
    if (resp.status === 404) throw new ServerError('NOT_FOUND', '模型不存在或无权访问');
    if (!resp.ok) throw new ServerError('LOAD_FAILED', `字段元数据加载失败 (${resp.status})`);
    return resp.json();
  }

  /** 列表查询（读语义 POST——预览态同路径放行）。 */
  async query(modelId: string | number, body: {
    filter?: FilterNode | Record<string, unknown>;
    fields?: string[];
    sort?: { field: string; order: 'asc' | 'desc' }[];
    page?: number;
    size?: number;
  }): Promise<unknown> {
    return this.post(`/api/data/${modelId}/query`, body);
  }

  /** 记录详情。 */
  async detail(modelId: string | number, recordId: string | number): Promise<unknown> {
    const resp = await fetch(`${this.config.baseUrl}/api/data/${modelId}/${recordId}`, {
      headers: this.headers(),
    });
    if (resp.status === 404) throw new ServerError('NOT_FOUND', '记录不存在');
    if (!resp.ok) throw new ServerError('LOAD_FAILED', `详情加载失败 (${resp.status})`);
    return resp.json();
  }

  /** 新建。 */
  async create(modelId: string | number, data: Record<string, unknown>): Promise<unknown> {
    return this.post(`/api/data/${modelId}`, data);
  }

  /** 更新。 */
  async update(modelId: string | number, recordId: string | number,
    data: Record<string, unknown>): Promise<unknown> {
    const resp = await fetch(`${this.config.baseUrl}/api/data/${modelId}/${recordId}`, {
      method: 'PUT', headers: this.headers(), body: JSON.stringify(data),
    });
    return this.unwrap(resp);
  }

  /** 唯一性预检。 */
  async uniqueCheck(modelId: string | number, fieldKey: string, value: unknown,
    excludeId?: string | number): Promise<boolean> {
    const body = excludeId != null ? { fieldKey, value, excludeId } : { fieldKey, value };
    const resp = await this.postRaw(`/api/data/${modelId}/unique-check`, body);
    const payload = (await resp.json()) as { unique?: boolean };
    return payload.unique !== false;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const resp = await this.postRaw(path, body);
    return this.unwrap(resp);
  }

  private postRaw(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.config.baseUrl}${path}`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body),
    });
  }

  /** 响应解包 + 服务端错误映射（03FE §7 字段级回填）。 */
  private async unwrap(resp: Response): Promise<unknown> {
    if (resp.ok) {
      const text = await resp.text();
      return text ? JSON.parse(text) : null;
    }
    let code = 'SERVER_ERROR';
    let message = `请求失败 (${resp.status})`;
    let fieldErrors: Record<string, string> = {};
    try {
      const body = (await resp.json()) as {
        code?: string; message?: string; details?: unknown; detail?: unknown;
      };
      if (body.code) code = body.code;
      if (body.message) message = body.message;
      // 422 VALIDATION_FAILED：details.fields → 字段级错误表（WriteValidator 真实结构：
      // {fields: {fieldKey: message}} 对象——此前误读 detail.fields 且假设数组，从未生效）
      const detailObj = (body.details ?? body.detail) as { fields?: unknown } | undefined;
      const fieldsRaw = detailObj && typeof detailObj === 'object' ? detailObj.fields : undefined;
      if (typeof fieldsRaw === 'string') {
        // writeNormalize 必填缺失形态：fields 为逗号分隔字段名列表
        fieldErrors = Object.fromEntries(
          fieldsRaw.split(',').map((f) => [f.trim(), body.message ?? '校验失败']),
        );
      } else if (Array.isArray(fieldsRaw)) {
        fieldErrors = Object.fromEntries(
          fieldsRaw.map((f) => [String(f), body.message ?? '校验失败']),
        );
      } else if (fieldsRaw && typeof fieldsRaw === 'object') {
        fieldErrors = Object.fromEntries(
          Object.entries(fieldsRaw as Record<string, unknown>)
            .map(([k, v]) => [k, String(v)]),
        );
      }
    } catch {
      // 非 JSON 错误体——保持默认全局错误
    }
    if (resp.status === 422) code = 'VALIDATION_FAILED';
    throw new ServerError(code, message, fieldErrors);
  }
}
