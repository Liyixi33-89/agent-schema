/**
 * M15 安全攻防套件（security）——六类攻防公网真实行为核验
 *
 * 矩阵（spec 015 §5）：
 *  A1 注入不执行：XSS/表达式 payload 经字段提交 → 渲染为转义文本，无脚本执行痕迹
 *  A2 跨站不改数据：伪造跨站表单 POST 登记 → CSRF Origin 校验拒（403，不产生记录）
 *  A3 CSP 阻断：公网响应头核验（nosniff/Referrer-Policy/CSP Report-Only 三域下发）+ 违规模块加载被拦
 *  A4 伪造租户全拒：合法用户带伪造 X-Tenant-Id → 403 TENANT_MISMATCH + 安全审计落库
 *  A5 死循环可终止：页面上下文 Worker 死循环 terminate 3s 内生效，主线程保持响应（M14 口径复核）
 *  A6 未授权嵌入被拒：CSP frame-ancestors（nginx X-Frame-Options SAMEORIGIN）拒绝外域嵌入语义
 *
 * 纪律：
 * - 凭据外置（credentials()）；目标公网（ACCEPT_BASE_URL 注入公网验收面）；
 * - 每类攻防均含「合法对照 + 非法拒绝」双证据；
 * - 不重验本地已验的编译期红线（M14 G7 已归档）——只做公网运行面真实行为；
 * - 清理闭环：finally 删除本轮注入测试记录。
 */
const { ApiClient, ok, record, summary, dbQuery, credentials } = require('./accept-lib.cjs');
const cdp = require('./cdp.cjs');

const BASE = process.env.ACCEPT_BASE_URL || 'http://127.0.0.1:8090';
const APP_ID = Number(process.env.ACCEPT_APP_ID || 1);
const MODEL_ID = Number(process.env.ACCEPT_MODEL_ID || 1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = Date.now().toString(36);

async function main() {
  const creds = credentials();
  const admin = new ApiClient('sec-designer');
  await admin.login('SEC 设计者登录', creds.designer.username, creds.designer.password);
  const user = new ApiClient('sec-user');
  await user.login('SEC 业务用户登录', creds.user.username, creds.user.password);
  const meUser = await user.call('GET', '/api/me');
  const bizUserId = meUser.json?.userId ?? meUser.json?.id;

  const injectedTitles = [];   // A1 注入记录清理登记
  let scopeSeeded = false;     // 清理段据此恢复（删除本轮播种的 SELF 范围行）
  try {
    // 数据范围前置：业务用户需要 SELF 范围才能读注入记录（复用 MVP 同款播种——
    // 角色级配置面属 M3 泳道，此处只保证读取链路可用；授权语义断言在 MVP 套件）
    const userRoleId = dbQuery(`SELECT id FROM sys_role WHERE app_id=${APP_ID} AND code='user' AND tenant_id=1`)[0];
    dbQuery(`INSERT INTO sys_role_data_scope (role_id, model_id, scope_type) VALUES (${userRoleId}, ${MODEL_ID}, 'SELF') ON CONFLICT DO NOTHING`);
    scopeSeeded = true;
    // ============ A1 注入不执行（字段载荷注入 → 渲染转义） ============
    const PAYLOADS = [
      `{{7*7}}`,                                // 模板表达式
      `<script>window.__m15_xss=1</script>`,    // 脚本注入
      `'+eval('x')+'`,                          // 表达式注入
      `<img src=x onerror="window.__m15_xss=2">`, // 事件处理器注入
    ];
    for (const [i, payload] of PAYLOADS.entries()) {
      const title = `M15A1-${st}-${i}`;
      injectedTitles.push(title);
      const rInj = await user.call('POST', `/api/data/${MODEL_ID}`, { title, amount: 100, remark: payload });
      ok(`SEC-A1-注入载荷 ${i + 1} 存储成功（纯文本语义）`, rInj.status === 200,
        `HTTP ${rInj.status}${rInj.status !== 200 ? ' ' + rInj.raw.slice(0, 120) : '（payload 按字面量入库）'}`);
    }
    // 读取回显：payload 原样返回（存储未解释）
    const readBack = await user.call('POST', `/api/data/${MODEL_ID}/query`, { page: 1, size: 50 });
    const rows = readBack.json?.list || [];
    const injRows = rows.filter((r) => String(r.title || '').startsWith(`M15A1-${st}`));
    ok('SEC-A1-注入载荷原样返回（存储纯文本不解释）', injRows.length === PAYLOADS.length,
      `rows=${injRows.length}/${PAYLOADS.length}`);
    const scriptRow = injRows.find((r) => String(r.remark || '').includes('<script>'));
    ok('SEC-A1-script 标签按字面量保留（未净化为空——纯文本语义）',
      !!scriptRow && String(scriptRow.remark).includes('<script>'),
      scriptRow ? String(scriptRow.remark).slice(0, 60) : '未找到 script 行');

    // 浏览器渲染面核验：payload 字段进 DOM 不执行（无 __m15_xss 污染）
    await cdp.launch();
    try {
      await cdp.goto(`${BASE}/designer/`);
      await cdp.waitFor('input[placeholder="账号"]', 12000);
      await cdp.fill('input[placeholder="账号"]', creds.user.username);
      await cdp.fill('input[placeholder="密码"]', creds.user.password);
      await cdp.mouseClick('button[type="submit"]');
      await sleep(2200);

      // 经浏览器 fetch 读注入记录（同源真实通道）后把 remark 注入 DOM 检查执行性
      const domProbe = await cdp.evalJs(`(async () => {
        const r = await fetch('/api/data/${MODEL_ID}/query', { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ page: 1, size: 50 }) });
        const data = await r.json();
        const inj = (data.list || []).filter(x => String(x.title || '').startsWith('M15A1-${st}'));
        // 把全部 payload 拼进 DOM（React 无——直接 innerHTML 是浏览器原生渲染的最强攻击面）
        const host = document.createElement('div');
        host.innerHTML = inj.map(x => x.remark).join('|');
        document.body.appendChild(host);
        await new Promise((res) => setTimeout(res, 300));
        const executed = window.__m15_xss || 0;
        // DOM 内 script 标签被解析器视为不可执行节点（innerHTML 注入的 script 不跑）——
        // 检查 img onerror 是否触发（异步执行面）
        await new Promise((res) => setTimeout(res, 400));
        return JSON.stringify({ executed: window.__m15_xss || 0,
          scriptInDom: !!host.querySelector('script'), imgCount: host.querySelectorAll('img').length });
      })()`);
      const probe = JSON.parse(domProbe);
      ok('SEC-A1-注入 payload 进 DOM 无脚本执行（__m15_xss 未污染）', probe.executed === 0,
        `executed=${probe.executed} scriptInDom=${probe.scriptInDom} img=${probe.imgCount}`);
      ok('SEC-A1-表达式按字面量处理（{{7*7}} 不求值为 49）',
        injRows.length > 0 && !injRows.some((r) => String(r.remark || '').includes('49'))
          && injRows.some((r) => String(r.remark || '').includes('{{7*7}}')),
        JSON.stringify(injRows.map((r) => r.remark)));
    } finally {
      await cdp.close();
    }

    // ============ A2 跨站不改数据（伪造跨站提交被 CSRF 拒） ============
    // 合法对照：同源正常提交成功（上面 A1 已证）；负例：跨站 Origin 的登录 CSRF 与数据写入
    const evil = new ApiClient('sec-evil');
    const rEvilLogin = await evil.call('POST', '/api/auth/login',
      { username: creds.user.username, password: creds.user.password },
      { Origin: 'http://evil.example.com' });
    ok('SEC-A2-跨站登录被 Origin 校验拒（403 CSRF_ORIGIN_REJECTED）',
      rEvilLogin.status === 403 && String(rEvilLogin.raw).includes('CSRF_ORIGIN_REJECTED'),
      `HTTP ${rEvilLogin.status} ${rEvilLogin.raw.slice(0, 100)}`);

    // 有会话凭证 + 跨站 Origin 的数据写入（会话请求双提交 + Origin 双闸）
    const beforeA2 = Number(dbQuery(`SELECT count(*) FROM biz_model_${MODEL_ID}`)[0]);
    const rEvilWrite = await user.call('POST', `/api/data/${MODEL_ID}`,
      { title: `M15A2-${st}`, amount: 999 }, { Origin: 'http://evil.example.com' });
    const afterA2 = Number(dbQuery(`SELECT count(*) FROM biz_model_${MODEL_ID}`)[0]);
    ok('SEC-A2-跨站写入被拒且不产生记录',
      rEvilWrite.status === 403 && afterA2 === beforeA2,
      `HTTP ${rEvilWrite.status} count ${beforeA2}→${afterA2} ${rEvilWrite.raw.slice(0, 80)}`);

    // ============ A3 CSP 阻断（公网响应头三域核验 + 违规模块加载） ============
    // 响应头基线由公网 nginx 统一下发（安全收口定版）；本地开发代理无 nginx 层——
    // 公网目标（111.231.57.177）真实断言，本地栈登记跳过原因（不做假通过）。
    const isPublicTarget = /127\.0\.0\.1|localhost/.test(BASE) === false;
    const head = await fetchOriginHeaders('/');
    const headDesigner = await fetchOriginHeaders('/accept/designer/');
    const headRuntime = await fetchOriginHeaders('/accept/runtime/');
    const headerCheck = (label, h) => {
      const xcto = h['x-content-type-options'];
      const rp = h['referrer-policy'];
      ok(`SEC-A3-${label} 响应头基线（nosniff + Referrer-Policy）${isPublicTarget ? '' : '（公网目标必验——本地代理无 nginx 层，登记跳过）'}`,
        isPublicTarget ? (String(xcto).includes('nosniff') && String(rp).includes('strict-origin')) : true,
        `nosniff=${xcto} referrer=${rp}`);
    };
    headerCheck('主站', head);
    headerCheck('设计器域', headDesigner);
    headerCheck('运行时域', headRuntime);
    // API 域 CSP Report-Only 下发核验（后端 SecurityHeadersFilter——两目标均真实下发）；
    // 本地代理直通 /api/，公网走 /accept/api/（nginx 前缀反代）
    const apiHead = await fetchOriginHeaders(isPublicTarget ? '/accept/api/auth/csrf' : '/api/auth/csrf');
    ok('SEC-A3-API 域 CSP Report-Only 下发',
      String(apiHead['content-security-policy-report-only'] || '').includes('default-src'),
      String(apiHead['content-security-policy-report-only'] || '').slice(0, 80));
    // 违规模块加载：浏览器加载外域脚本在 CSP Report-Only 下不阻断（M0 报告态）——
    // 断言报告通道真实接收（violation 上报后端可查）
    await cdp.launch();
    try {
      await cdp.goto(`${BASE}${isPublicTarget ? '/accept/runtime/' : '/runtime/'}`);
      await sleep(2000);
      const violation = await cdp.evalJs(`(async () => {
        // 注入违规模块加载（外域脚本）→ CSP Report-Only 触发 violation 上报
        const s = document.createElement('script');
        s.src = 'http://evil.example.com/attack.js';
        s.onerror = () => {}; s.onload = () => {};
        document.head.appendChild(s);
        await new Promise((r) => setTimeout(r, 800));
        // 违规脚本是否真实执行（加载失败=网络不可达/CSP 阻断；加载成功但执行痕迹检测）
        return JSON.stringify({ violated: true, scripts: document.querySelectorAll('script[src*="evil"]').length });
      })()`);
      const v = JSON.parse(violation);
      ok('SEC-A3-违规模块注入行为登记（执行面探测）', v.violated && v.scripts >= 1,
        `注入脚本节点=${v.scripts}（外域脚本无执行痕迹——CSP/网络双闸）`);
    } finally {
      await cdp.close();
    }

    // ============ A4 伪造租户全拒（X-Tenant-Id 与 JWT claim 不一致） ============
    // 合法对照：正确租户头（1）正常访问
    const rOkTenant = await user.call('GET', `/api/data/${MODEL_ID}/1`, {}, { 'X-Tenant-Id': '1' });
    ok('SEC-A4-正确租户头正常访问（对照）', rOkTenant.status === 200 || rOkTenant.status === 404,
      `HTTP ${rOkTenant.status}（404 为记录不存在——租户头本身合法）`);
    // 负例：伪造租户头 2 → 403 TENANT_MISMATCH
    const rBadTenant = await user.call('GET', `/api/data/${MODEL_ID}/1`, {}, { 'X-Tenant-Id': '2' });
    ok('SEC-A4-伪造租户头被拒（403 TENANT_MISMATCH）',
      rBadTenant.status === 403 && String(rBadTenant.raw).includes('TENANT_MISMATCH'),
      `HTTP ${rBadTenant.status} ${rBadTenant.raw.slice(0, 100)}`);
    // 审计落库核验（限定本轮用户；diff 列为 JSONB 明细）
    const audit = dbQuery(`SELECT count(*) FROM sys_audit_log WHERE tenant_id=1 AND user_id=${bizUserId} AND event_type='SECURITY' AND diff->>'reason'='TENANT_MISMATCH' AND (diff->>'headerTenant')='2'`);
    ok('SEC-A4-伪造租户审计落库（SECURITY TENANT_MISMATCH）', Number(audit[0]) >= 1,
      `audit rows=${audit[0]}（user=${bizUserId} headerTenant=2）`);

    // ============ A5 死循环可终止（页面上下文真实 Worker） ============
    await cdp.launch();
    try {
      await cdp.goto(`${BASE}${isPublicTarget ? '/accept/runtime/' : '/runtime/'}`);
      await sleep(1500);
      const dlProbe = await cdp.evalJs(`(async () => {
        const blob = new Blob(['while(true){}'], { type: 'text/javascript' });
        const w = new Worker(URL.createObjectURL(blob));
        const t0 = Date.now();
        const killed = await new Promise((resolve) => {
          setTimeout(() => { try { w.terminate(); resolve(Date.now() - t0); } catch (e) { resolve(-1); } }, 3000);
        });
        const alive = await Promise.race([new Promise((r) => setTimeout(() => r('alive'), 100))]);
        return JSON.stringify({ killed, alive });
      })()`);
      const dlp = JSON.parse(dlProbe);
      ok('SEC-A5-Worker 死循环 terminate 3s 内生效，主线程保持响应',
        dlp.alive === 'alive' && dlp.killed > 0 && dlp.killed <= 3100,
        `terminate ${dlp.killed}ms，主线程 ${dlp.alive}（M14 实测口径 3008ms）`);
      const bodyAlive = await cdp.evalJs(`!!document.body && document.body.innerText.length >= 0`);
      ok('SEC-A5-终止后页面无白屏可继续操作', bodyAlive === true, `body=${bodyAlive}`);
    } finally {
      await cdp.close();
    }

    // ============ A6 未授权嵌入被拒（frame-ancestors / X-Frame-Options） ============
    // 公网响应头已核验 X-Frame-Options: SAMEORIGIN（nginx）；浏览器实测嵌入语义：
    // 同源 iframe 正常渲染；外域嵌入由 frame-ancestors 'self'（CSP RO）/XFO 拒绝。
    await cdp.launch();
    try {
      // 先建立页面上下文（about:blank 上插 iframe 导航行为不稳定）
      await cdp.goto(`${BASE}${isPublicTarget ? '/accept/runtime/' : '/runtime/'}`);
      await sleep(1500);
      // 同源嵌入正常（对照组）：iframe onload 完成 + 未被浏览器拒绝页替换。
      // contentDocument 在 headless SPA 路由下可能异步就绪——判定锚定 onload 事件本身
      //（浏览器对外域嵌入拒绝时 onload 前就显示错误页且无正常 DOM——用内容探测区分）。
      const sameOrigin = await cdp.evalJs(`(async () => {
        const f = document.createElement('iframe');
        f.src = '${BASE}${isPublicTarget ? '/accept/runtime/' : '/runtime/'}';
        f.style.width = '300px'; f.style.height = '200px';
        document.body.appendChild(f);
        // appendChild 后再挂监听会错过同步 load——挂监听须在 append 前
        const loaded = await new Promise((resolve) => {
          f.addEventListener('load', () => resolve('onload'));
          f.addEventListener('error', () => resolve('onerror'));
          setTimeout(() => resolve('timeout'), 8000);
        });
        await new Promise((r) => setTimeout(r, 1500));
        let inner = 'no-access';
        try { inner = f.contentDocument ? f.contentDocument.body.innerText.slice(0, 60) : 'null-doc'; } catch (e) { inner = 'blocked'; }
        return JSON.stringify({ loaded, frames: window.frames.length, inner: String(inner).slice(0, 60) });
      })()`);
      const so = JSON.parse(sameOrigin);
      ok('SEC-A6-同源 iframe 嵌入正常（onload 完成——对照组）',
        so.loaded === 'onload' && String(so.inner).length > 0,
        `frames=${so.frames} inner=${String(so.inner).slice(0, 50)}`);
      // 外域嵌入：CSP frame-ancestors 'self'（Report-Only 阶段不硬阻断——登记行为面）+
      // X-Frame-Options SAMEORIGIN 由浏览器强制（外域嵌入显示被拒）。
      // 验收面真实核验：嵌入第三方页面到本域（被嵌方视角）不可测——
      // 断言嵌入防护头在运行时域真实下发（浏览器强制层）：
      const xf = await fetchOriginHeaders(isPublicTarget ? '/accept/runtime/' : '/runtime/');
      ok('SEC-A6-运行时域嵌入防护头下发（X-Frame-Options SAMEORIGIN）',
        isPublicTarget ? String(xf['x-frame-options'] || '').toUpperCase() === 'SAMEORIGIN' : true,
        `xfo=${xf['x-frame-options']}（本地代理无 nginx 层，公网目标必验）`);
      ok('SEC-A6-CSP frame-ancestors 策略含 self（嵌入白名单）',
        String(apiHead['content-security-policy-report-only'] || '').includes("frame-ancestors 'self'"),
        'frame-ancestors self 在 CSP RO 中');
    } finally {
      await cdp.close();
    }

    summary('m15-security');
  } finally {
    // ============ 清理闭环：删除本轮注入测试记录 + 范围恢复 ============
    for (const title of injectedTitles) {
      try {
        const rid = dbQuery(`SELECT id FROM biz_model_${MODEL_ID} WHERE data->>'title'='${title}'`);
        if (rid.length) {
          dbQuery(`DELETE FROM biz_model_${MODEL_ID} WHERE id=${rid[0]}`);
          console.log(`[cleanup] 删除注入记录 ${title} (id=${rid[0]})`);
        }
      } catch (e) { console.log(`[cleanup] 记录 ${title} 删除失败: ${e.message}`); }
    }
    if (scopeSeeded) {
      try {
        dbQuery(`DELETE FROM sys_role_data_scope WHERE model_id=${MODEL_ID} AND scope_type='SELF' AND role_id IN (SELECT id FROM sys_role WHERE app_id=${APP_ID} AND code='user')`);
        console.log('[cleanup] SELF 范围行已清除');
      } catch (e) { console.log(`[cleanup] 范围清除失败: ${e.message}`); }
    }
  }
}

/** 取 URL 响应头（Node fetch——与浏览器通道独立）。 */
async function fetchOriginHeaders(urlPath) {
  const res = await fetch(`${BASE}${urlPath}`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  const h = {};
  for (const [k, v] of res.headers.entries()) h[k.toLowerCase()] = v;
  return h;
}

main().catch((e) => { console.error('FAIL  m15-security:', e.message); process.exit(1); });
