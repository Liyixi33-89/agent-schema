/**
 * 请求层测试：ApiError 携带状态码 + isForbidden 按状态码判定（不匹配文案）。
 * 策略：mock auth-sdk 的 authFetch（避免真实网络与 Cookie 依赖）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@schema/auth-sdk', () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from '@schema/auth-sdk';
import { ApiError, isForbidden, req } from '../src/api';

const mockedFetch = vi.mocked(authFetch);

function resp(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    clone() { return this; },
  } as unknown as Response;
}

afterEach(() => { vi.clearAllMocks(); });

describe('req 错误类型', () => {
  it('非 2xx 抛 ApiError 且携带 status/code/message', async () => {
    mockedFetch.mockResolvedValueOnce(resp(403, { message: '您没有该资源的访问权限', code: 'FORBIDDEN' }));
    await expect(req('GET', '/api/x')).rejects.toMatchObject({
      name: 'ApiError', status: 403, code: 'FORBIDDEN', message: '您没有该资源的访问权限',
    });
  });

  it('401 抛 ApiError(401) 且提示重新登录', async () => {
    mockedFetch.mockResolvedValueOnce(resp(401, {}));
    const e = await req('GET', '/api/x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(401);
  });

  it('2xx 返回解析后的 JSON', async () => {
    mockedFetch.mockResolvedValueOnce(resp(200, { ok: 1 }));
    await expect(req('GET', '/api/x')).resolves.toEqual({ ok: 1 });
  });

  it('透传 AbortSignal 到 authFetch', async () => {
    mockedFetch.mockResolvedValueOnce(resp(200, {}));
    const ctrl = new AbortController();
    await req('GET', '/api/x', undefined, ctrl.signal);
    expect(mockedFetch.mock.calls[0][0]).toMatchObject({ signal: ctrl.signal });
  });
});

describe('isForbidden（按状态码，不匹配文案）', () => {
  it('ApiError 403 → true（即使文案不含 403）', () => {
    expect(isForbidden(new ApiError('无权限', 403))).toBe(true);
  });
  it('ApiError 500 文案含 403 → false', () => {
    expect(isForbidden(new ApiError('请求失败 (500) 403', 500))).toBe(false);
  });
  it('普通 Error 文案含 403 → false（不再靠文案）', () => {
    expect(isForbidden(new Error('请求失败 (403)'))).toBe(false);
  });
  it('非错误对象 → false', () => {
    expect(isForbidden(null)).toBe(false);
    expect(isForbidden('403')).toBe(false);
  });
});