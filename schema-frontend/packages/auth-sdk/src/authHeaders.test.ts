/**
 * authHeaders 头重复拼接回归测试（2026-11-26 真实缺陷）。
 *
 * ## 缺陷现象
 * 写请求（POST/PUT）后端返回 403 CSRF_TOKEN_REJECTED，但：
 * - 同页面 GET 正常（GET 不校验 CSRF）
 * - 浏览器内手动 fetch + csrf 头正常
 * - 只有走封装层（RequestClient.post → authFetch）的写请求失败
 *
 * ## 根因
 * `mergeAuthHeaders` 把 `new Headers(headers)` 摊平成普通对象时键被归一化为
 * **小写**（'x-csrf-token'）；`authHeaders` 随后用**大写**键写入
 * （'X-CSRF-Token'）。普通 JS 对象里二者并存，传回 `Headers` 时按大小写
 * 不敏感合并 → 头值变成 `"t, t"` → 后端逐字比对失败。
 *
 * ## 本测试
 * 直接断言 authHeaders 输出中不存在同时含大小写变体的重复键。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { authHeaders } from './index';

/** 在 node 环境造 document.cookie 与 localStorage（本包无 jsdom）。 */
function stubBrowserEnv(cookie: string, tenant: string | null): void {
  vi.stubGlobal('document', { cookie });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k === 'schema_tenant' ? tenant : null),
  });
}

describe('authHeaders 大小写去重', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('🔴 传入小写键时不得同时出现大写键（否则 Headers 会拼成 "t, t"）', () => {
    stubBrowserEnv('schema_csrf=TOKEN_A', null);
    // 模拟 mergeAuthHeaders 的产物：键已归一化为小写
    const out = authHeaders({ 'x-csrf-token': 'TOKEN_A', 'content-type': 'application/json' });

    const csrfKeys = Object.keys(out).filter((k) => k.toLowerCase() === 'x-csrf-token');
    expect(csrfKeys, `重复的 CSRF 键会导致 403：${JSON.stringify(out)}`).toHaveLength(1);
    expect(out['X-CSRF-Token']).toBe('TOKEN_A');
  });

  it('租户头同样去重', () => {
    stubBrowserEnv('schema_csrf=T', 'tenant-from-storage');
    const out = authHeaders({ 'x-tenant-id': 'stale-tenant' });
    const keys = Object.keys(out).filter((k) => k.toLowerCase() === 'x-tenant-id');
    expect(keys).toHaveLength(1);
    expect(out['X-Tenant-Id']).toBe('tenant-from-storage');
  });

  it('无 cookie 时不写入 CSRF 头，也不残留旧变体', () => {
    stubBrowserEnv('', null);
    const out = authHeaders({ 'x-csrf-token': 'STALE' });
    const keys = Object.keys(out).filter((k) => k.toLowerCase() === 'x-csrf-token');
    expect(keys).toHaveLength(0);
  });

  it('普通头原样保留', () => {
    stubBrowserEnv('schema_csrf=T', null);
    const out = authHeaders({ 'content-type': 'application/json' });
    expect(out['content-type']).toBe('application/json');
  });

  it('用真实 Headers 复现「拼接」——修复后不再出现 "t, t"', () => {
    stubBrowserEnv('schema_csrf=TOKEN_B', null);
    const out = authHeaders({ 'x-csrf-token': 'TOKEN_B' });
    const h = new Headers(out);
    expect(h.get('X-CSRF-Token'), '头值不得被拼接').toBe('TOKEN_B');
  });
});