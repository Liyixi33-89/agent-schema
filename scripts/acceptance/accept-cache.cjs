/**
 * M11 浏览器验收 ④：缓存与发布隔离专项（同上下文链路）
 * 覆盖：ETag/304 往返、草稿不影响正式、发布使旧 ETag 失效、预览与正式隔离、登出清理。
 * 前置：accept-runtime/designer 已跑通（应用 1 页面 1 已发布 v6 基线）。
 */
const { BASE, ok, ApiClient, dbQuery, summary } = require('./accept-lib.cjs');
const PW = process.env.ACCEPT_PASSWORD || 'Accept!2026';

(async () => {
  const admin = new ApiClient('admin');

  // ---------- 1. 登录 + 基线 ETag ----------
  await admin.login('API 管理员登录', 'accept_admin', PW);
  const first = await admin.call('GET', '/api/runtime/pages/1');
  const etag1 = (first.headers.etag || '').replace(/"/g, '');
  ok('运行时读取含 ETag', first.status === 200 && !!etag1, `etag=${etag1} cc=${first.headers['cache-control']}`);
  ok('缓存指令 private must-revalidate', (first.headers['cache-control'] || '').includes('private')
    && (first.headers['cache-control'] || '').includes('must-revalidate'), first.headers['cache-control']);

  // ---------- 2. If-None-Match 命中 → 304 ----------
  const hit = await admin.call('GET', '/api/runtime/pages/1', null, { 'If-None-Match': `"${etag1}"` });
  ok('If-None-Match 命中 304', hit.status === 304, `HTTP ${hit.status}`);
  const miss = await admin.call('GET', '/api/runtime/pages/1', null, { 'If-None-Match': '"v-nonexistent"' });
  ok('If-None-Match 未命中 200 带全量', miss.status === 200 && !!miss.json, `HTTP ${miss.status}`);

  // ---------- 3. 草稿修改不影响正式（发布前验证——发布会把草稿内容推上正式） ----------
  const draft = await admin.call('GET', '/api/pages/1/draft');
  ok('读取草稿', draft.status === 200, `HTTP ${draft.status}`);
  const schema = draft.json?.schema || draft.json || {};
  // 记录原名，草稿改名（只动草稿）
  const originalName = schema.name;
  const draftBody = JSON.parse(JSON.stringify(schema));
  if (draftBody.name) draftBody.name = `草稿干扰验证-${Date.now().toString(36)}`;
  const draftVersion = draft.json?.draftVersion ?? draft.json?.schema?.draftVersion;
  await admin.expect('保存草稿', 'PUT', '/api/pages/1/draft', 200,
    draftVersion != null ? { schema: draftBody, baseDraftVersion: draftVersion } : { schema: draftBody });
  // 正式读取不受影响——ETag 不变、内容不含草稿标记
  const afterDraft = await admin.call('GET', '/api/runtime/pages/1', null, { 'If-None-Match': `"${etag1}"` });
  ok('草稿保存后正式 ETag 仍 304', afterDraft.status === 304, `HTTP ${afterDraft.status}`);
  const afterDraftFull = await admin.call('GET', '/api/runtime/pages/1');
  ok('正式内容不含草稿改动', !JSON.stringify(afterDraftFull.json || {}).includes('草稿干扰验证'),
    JSON.stringify(afterDraftFull.json?.name || '').slice(0, 80));
  // 草稿还原（后续发布验证用原名，避免污染）
  await admin.call('PUT', '/api/pages/1/draft',
    { schema: { ...draftBody, name: originalName }, baseDraftVersion: (draftVersion != null ? draftVersion : 0) + 1 });

  // ---------- 4. 发布使旧 ETag 失效 ----------
  const pub = await admin.call('POST', '/api/apps/1/publish', { changelog: 'M11 缓存验收-发布轮换' });
  ok('发布成功', pub.status === 200, `HTTP ${pub.status} ${pub.raw.slice(0, 100)}`);
  const afterPub = await admin.call('GET', '/api/runtime/pages/1', null, { 'If-None-Match': `"${etag1}"` });
  ok('发布后旧 ETag 失效(200 全量)', afterPub.status === 200, `HTTP ${afterPub.status}`);
  const etag2 = (afterPub.headers.etag || '').replace(/"/g, '');
  ok('新 ETag 已轮换', etag2 && etag2 !== etag1, `${etag1} → ${etag2}`);
  const hit2 = await admin.call('GET', '/api/runtime/pages/1', null, { 'If-None-Match': `"${etag2}"` });
  ok('新 ETag 命中 304', hit2.status === 304, `HTTP ${hit2.status}`);

  // ---------- 5. 预览凭证与正式会话隔离 ----------
  const grant = await admin.call('POST', '/api/apps/1/preview-grants', { pageId: 1 });
  ok('签发预览凭证', grant.status === 200 && !!grant.json?.grantId, JSON.stringify(grant.json).slice(0, 120));
  // /api/preview/* 预览端点组不接受正式会话凭证（JwtAuthFilter 83）——exchange 必须匿名调用
  const anon = new ApiClient('anon');
  const exchanged = await anon.call('POST', '/api/preview/exchange', { grantId: grant.json?.grantId });
  ok('预览凭证兑换短时会话', exchanged.status === 200 && !!exchanged.json?.accessToken,
    JSON.stringify(exchanged.json).slice(0, 120));
  // 预览凭证是独立通道——Bearer 短时 token 读指定页面
  const previewClient = new ApiClient('preview');
  const pv = await previewClient.call('GET', '/api/runtime/pages/1', null,
    { Authorization: `Bearer ${exchanged.json?.accessToken}` });
  ok('预览 token 可读指定页面', pv.status === 200, `HTTP ${pv.status}`);
  const pvOther = await previewClient.call('GET', '/api/runtime/pages/999', null,
    { Authorization: `Bearer ${exchanged.json?.accessToken}` });
  ok('预览限页(其他页面 404/403)', pvOther.status === 404 || pvOther.status === 403, `HTTP ${pvOther.status}`);
  // 正式会话无预览标记——不带 Authorization 走 cookie 的读取不受预览范围约束
  const formal = await admin.call('GET', '/api/runtime/pages/1');
  ok('正式通道独立可用', formal.status === 200, `HTTP ${formal.status}`);
  // 吊销预览会话（预览端点组：须带预览 token 自我吊销——正式凭证与匿名均被拒）
  const sessionUuid = exchanged.json?.previewSessionId;
  const revoked = await previewClient.call('POST', `/api/preview/sessions/${sessionUuid}/revoke`, {},
    { Authorization: `Bearer ${exchanged.json?.accessToken}` });
  ok('预览会话吊销', revoked.status === 200, `HTTP ${revoked.status}`);
  const pvAfter = await previewClient.call('GET', '/api/runtime/pages/1', null,
    { Authorization: `Bearer ${exchanged.json?.accessToken}` });
  ok('吊销后预览读取被拒', pvAfter.status === 401 || pvAfter.status === 403, `HTTP ${pvAfter.status}`);

  // ---------- 6. 登出后凭证清理 ----------
  await admin.expect('登出', 'POST', '/api/auth/logout', 200, {});
  ok('登出后 cookie 清空', !admin.cookies.has('schema_at') && !admin.cookies.has('schema_rt'),
    `at=${admin.cookies.has('schema_at')} rt=${admin.cookies.has('schema_rt')}`);
  const deniedRuntime = await admin.call('GET', '/api/runtime/pages/1');
  ok('登出后运行时读取 401', deniedRuntime.status === 401, `HTTP ${deniedRuntime.status}`);

  summary('cache-isolation');
})().catch((e) => {
  console.error('FATAL:', e.message);
  summary('cache-isolation');
  process.exitCode = 1;
});
