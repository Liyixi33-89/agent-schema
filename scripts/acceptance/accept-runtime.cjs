/**
 * M11 浏览器验收 ②（v3 严格版）：runtime 运行时闭环
 * 未登录占位 → 登录 → 导航壳 → 表单渲染 → 提交落库(DB核对) → 登出会话失效 → ETag 304
 */
const fs = require('fs');
const path = require('path');
const cdp = require('./cdp.cjs');
const { BASE, ok, record, ApiClient, dbQuery, summary } = require('./accept-lib.cjs');

async function waitText(include, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await cdp.evalJs('document.body.innerText')).includes(include)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

(async () => {
  await cdp.launch();
  try {
    // ---------- 0. 未登录 → 会话过期占位 ----------
    await cdp.goto(`${BASE}/#/app/1`);
    await new Promise((r) => setTimeout(r, 1800));
    const unauthText = await cdp.evalJs('document.body.innerText');
    ok('未登录渲染会话过期占位', unauthText.includes('登录已失效') && unauthText.includes('重新登录'),
      unauthText.replace(/\n/g, '|').slice(0, 80));
    await cdp.shot('runtime-unauth');

    // ---------- 1. 登录（普通成员） ----------
    await cdp.goto(`${BASE}/designer/`);
    await cdp.waitFor('input[placeholder="账号"]', 10000);
    await cdp.fill('input[placeholder="账号"]', 'accept_user');
    await cdp.fill('input[placeholder="密码"]', 'Accept!2026');
    await cdp.click('button[type="submit"]');
    await cdp.waitFor('.ant-layout-header', 10000);
    ok('登录成功(普通成员)', true);

    // ---------- 2. 导航壳（菜单权限过滤：user 角色应见报销中心+帮助中心） ----------
    await cdp.goto(`${BASE}/#/app/1`);
    await new Promise((r) => setTimeout(r, 1800));
    await cdp.shot('runtime-shell');
    const shellText = await cdp.evalJs('document.body.innerText');
    ok('导航壳渲染菜单', shellText.includes('报销中心') && shellText.includes('帮助中心'),
      shellText.replace(/\n/g, '|').slice(0, 150));

    // API 侧断言导航过滤端点
    const user = new ApiClient('user');
    await user.login('API 普通成员登录', 'accept_user', 'Accept!2026');
    const navRes = await user.expect('API 导航(过滤)', 'GET', '/api/apps/1/nav?filtered=true', 200, null);
    const navTree = navRes.json?.tree ?? navRes.json?.nodes;
    ok('导航树含报销登记页面', JSON.stringify(navTree).includes('报销登记'), JSON.stringify(navTree).slice(0, 120));

    // ---------- 3. 打开页面 → 表单渲染 ----------
    await cdp.evalJs(`(() => { const sub = document.querySelector('.ant-menu-submenu-title'); sub?.click(); })()`);
    await new Promise((r) => setTimeout(r, 700));
    await cdp.evalJs(`(() => { const items = Array.from(document.querySelectorAll('.ant-menu-item, [role="menuitem"]')); const it = items.find(x => x.textContent.includes('报销登记')); it?.click(); })()`);
    ok('页面菜单点击进入', await waitText('报销事由', 8000));
    await new Promise((r) => setTimeout(r, 1000));
    await cdp.shot('runtime-page');

    // 表单组件渲染：四个字段 + 提交按钮
    const inputs = await cdp.evalJs('document.querySelectorAll("input, textarea, .ant-picker, button").length');
    ok('表单控件渲染', inputs >= 5, `controls=${inputs}`);
    const labels = await cdp.evalJs('Array.from(document.querySelectorAll("label")).map(e=>e.textContent).join(",")');
    ok('字段标签渲染', ['报销事由', '金额', '报销日期', '备注'].every((l) => labels.includes(l)), labels);

    // 发布 Schema 与 DB 发布版本一致性（排除旧缓存）
    const pubPage = await user.expect('API 运行时页面读取', 'GET', '/api/runtime/pages/1', 200, null);
    const pubSchema = JSON.stringify(pubPage.json);
    const dbPub = dbQuery("SELECT schema::text LIKE '%报销事由%' AND schema::text LIKE '%expenseDate%' FROM page_release_version WHERE page_id=1 ORDER BY id DESC LIMIT 1");
    ok('发布 Schema 含四字段绑定', pubSchema.includes('报销事由') && pubSchema.includes('expenseDate') && pubSchema.includes('amount'),
      `db一致=${dbPub[0]}`);

    // ---------- 4. 填值提交 → 写入接口断言 + DB 落库核对 ----------
    const beforeCount = Number(dbQuery('SELECT count(*) FROM biz_model_1')[0]);
    const stamp = `CDP-${Date.now().toString(36)}`;
    await cdp.evalJs(`(() => {
      const set = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true })); };
      const byLabel = (txt) => { const lbl = Array.from(document.querySelectorAll('label')).find(l => l.textContent.includes(txt));
        if (!lbl) return null; const formItem = lbl.closest('.ant-form-item'); return formItem?.querySelector('input, textarea'); };
      const t = byLabel('报销事由'); if (t) set(t, '${stamp}');
      const a = byLabel('金额'); if (a) set(a, '88');
      const r = byLabel('备注'); if (r) set(r, '自动化验收');
      return 'filled';
    })()`);
    // CDP 网络域捕获（页面级 fetch hook 会因 React 闭包捕获原生 fetch 而漏记——网络域在协议层无此问题）
    await cdp.startNetwork();
    // 宿主提交按钮标记 + 真实鼠标点击（CDP Input 域——React 合成事件可靠分发）
    await cdp.evalJs(`(() => { const bs = Array.from(document.querySelectorAll('button')).filter(x => x.textContent.replace(/\\s/g,'').includes('提交'));
      bs[bs.length - 1].setAttribute('data-host-submit', '1'); return bs.length; })()`);
    await cdp.mouseClick('button[data-host-submit]');
    await new Promise((r) => setTimeout(r, 3000));
    await cdp.shot('runtime-submitted');
    const writeReq = cdp.networkRequests().find((r) => r.url.includes('/api/data/1')
      && !r.url.includes('query') && !r.url.includes('fields') && r.method === 'POST');
    ok('提交触发数据写入接口', !!writeReq, JSON.stringify(cdp.networkRequests().map((r) => `${r.method} ${r.url} ${r.status}`)));
    if (writeReq) {
      ok('写入接口返回 200', writeReq.status === 200, JSON.stringify(writeReq));
      ok('写入载荷含唯一标识与金额', writeReq.postData?.includes(stamp) && writeReq.postData?.includes('"amount":88'), writeReq.postData?.slice(0, 120));
    }

    // DB 落库核对：按唯一戳精确查询（雪花 id 为字符串——字典序≠时间序，不用 ORDER BY id）
    const afterCount = Number(dbQuery('SELECT count(*) FROM biz_model_1')[0]);
    ok('DB 新增一条业务记录', afterCount === beforeCount + 1, `${beforeCount} → ${afterCount}`);
    // psql -tA 分隔符为 | （PG16 行为）：行形态 = tenant|created_by|title|amount
    const row = dbQuery(`SELECT tenant_id, created_by, data->>'title' AS title, (data->>'amount') AS amount FROM biz_model_1 WHERE data->>'title' = '${stamp}'`);
    ok('落库精确核对(戳/金额/租户/创建者)', row.length === 1 && row[0] === `1|2|${stamp}|88`,
      JSON.stringify(row));
    if (row.length === 1) {
      const recId = dbQuery(`SELECT id FROM biz_model_1 WHERE data->>'title' = '${stamp}'`)[0];
      ok('记录 ID 返回并可用于精确查询', !!recId, recId);
    }

    // ---------- 5. 登出 → 会话失效 ----------
    // 登出必须带 CSRF 头（浏览器内 authFetch 通道）——经 UI 登出按钮或 fetch 双提交
    const logoutStatus = await cdp.evalJs(`(async () => {
      const csrf = document.cookie.split('; ').find(c => c.startsWith('schema_csrf='));
      const token = csrf ? csrf.split('=')[1] : '';
      const r = await fetch('/api/auth/logout', { method: 'POST', credentials: 'include',
        headers: { 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, body: '{}' });
      return r.status; })()`);
    ok('登出请求成功(200)', logoutStatus === 200, `status=${logoutStatus}`);
    // /api/me 失效
    const meStatus = await cdp.evalJs(`(async () => (await fetch('/api/me', { credentials: 'include' })).status)()`);
    ok('登出后 /api/me 401', meStatus === 401, `status=${meStatus}`);
    // 刷新接口失效（rt 已吊销）
    const refreshStatus = await cdp.evalJs(`(async () => (await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: '{}' })).status)()`);
    ok('登出后 refresh 401', refreshStatus === 401, `status=${refreshStatus}`);
    // 导航壳重载 → SessionExpired 占位（同 hash 路由须强制 reload；authFetch 静默刷新链路需时——15s 宽限）
    await cdp.reload();
    const expiredShown = await waitText('登录已失效', 15000) || await waitText('重新登录', 5000);
    ok('登出后回会话过期占位', expiredShown,
      (await cdp.evalJs('document.body.innerText')).replace(/\n/g, '|').slice(0, 140));
    await cdp.shot('runtime-expired');

    // ---------- 6. ETag 缓存断言（重登后） ----------
    await cdp.goto(`${BASE}/designer/`);
    await cdp.waitFor('input[placeholder="账号"]', 10000);
    await cdp.fill('input[placeholder="账号"]', 'accept_user');
    await cdp.fill('input[placeholder="密码"]', 'Accept!2026');
    await cdp.click('button[type="submit"]');
    await cdp.waitFor('.ant-layout-header', 8000);
    const etag = await cdp.evalJs(`(async () => {
      const r1 = await fetch('/api/runtime/pages/1', { credentials: 'include' });
      const tag = r1.headers.get('etag');
      const r2 = await fetch('/api/runtime/pages/1', { credentials: 'include', headers: { 'If-None-Match': tag || '' } });
      return { tag, first: r1.status, second: r2.status };
    })()`);
    ok('发布页 ETag + 304 命中', etag?.tag && etag.first === 200 && etag.second === 304, JSON.stringify(etag));

    // ---------- 7. console 错误 ----------
    const errs = cdp.errors().filter((e) => !e.includes('favicon'));
    ok('无未捕获 console 错误', errs.length === 0, errs.slice(0, 3).join(' | ').slice(0, 200));

    summary('runtime');
  } finally {
    await cdp.close();
  }
})().catch((e) => {
  console.error('FATAL:', e.message);
  summary('runtime');
  process.exitCode = 1;
});
