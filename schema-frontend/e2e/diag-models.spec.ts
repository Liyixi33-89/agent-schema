import { test, expect } from './fixtures';

/** 诊断：列出可用模型与页面，供 E2E 复用。 */
test('DIAG 可用模型与页面', async ({ page, baseURL }) => {
  const base = String(baseURL).replace(/\/$/, '');
  const ctx = page.context();
  const explicit = process.env.SMOKE_API_BASE;
  const origin = explicit && explicit.trim() !== '' ? explicit.replace(/\/$/, '') : new URL(base).origin;

  await ctx.request.get(`${origin}/api/auth/csrf`);
  const c1 = (await ctx.cookies()).find((c) => c.name === 'schema_csrf')?.value ?? '';
  await ctx.request.post(`${origin}/api/auth/login`, {
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-CSRF-Token': c1 },
    data: { username: process.env.SMOKE_USERNAME ?? 'admin', password: process.env.SMOKE_PASSWORD ?? 'Accept!2026' },
  });
  const csrf = (await ctx.cookies()).find((c) => c.name === 'schema_csrf')?.value ?? '';
  const h = { 'Content-Type': 'application/json', Origin: origin, 'X-CSRF-Token': csrf, 'X-App-Id': '1' };

  const models = await ctx.request.get(`${origin}/api/models`, { headers: h });
  const mb = await models.json();
  console.log('[diag] models status=', models.status());
  console.log('[diag] models 原始响应 =', JSON.stringify(mb).slice(0, 600));
  const mlist = (mb as { list?: unknown[] }).list ?? (Array.isArray(mb) ? mb : []);
  console.log('[diag] 模型数 =', mlist.length);
  for (const m of mlist.slice(0, 5)) {
    const mm = m as Record<string, unknown>;
    console.log('[diag]   模型', JSON.stringify({ id: mm.id, name: mm.name, modelKey: mm.modelKey }));
  }

  const pages = await ctx.request.get(`${origin}/api/pages?appId=1`, { headers: h });
  const pb = await pages.json();
  console.log('[diag] pages status=', pages.status());
  console.log('[diag] pages 原始响应 =', JSON.stringify(pb).slice(0, 600));
  const plist = (pb as { list?: unknown[] }).list ?? (Array.isArray(pb) ? pb : []);
  console.log('[diag] 页面数 =', plist.length);
  for (const p of plist.slice(0, 8)) {
    const pp = p as Record<string, unknown>;
    console.log('[diag]   页面', JSON.stringify({
      id: pp.id, name: pp.name, type: pp.type, modelId: pp.modelId, status: pp.status,
    }));
  }

  expect(true).toBe(true);
});