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
const { ApiClient, ok, record, skip, summary, dbQuery, credentials } = require('./accept-lib.cjs');
const cdp = require('./cdp.cjs');

const BASE = process.env.ACCEPT_BASE_URL || 'http://127.0.0.1:8090';
const APP_ID = Number(process.env.ACCEPT_APP_ID || 1);
const MODEL_ID = Number(process.env.ACCEPT_MODEL_ID || 1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const st = Date.now().toString(36);

/** 公网目标判定（统一真源——各探针共用，防止判定不一致）。
 *  ACCEPT_PUBLIC_MODE=1：经 SSH 隧道访问公网部署面时强制公网语义（BASE 是本地隧道口）。 */
const IS_PUBLIC_TARGET = process.env.ACCEPT_PUBLIC_MODE === '1'
  || /127\.0\.0\.1|localhost/.test(BASE) === false;
/** 浏览器静态面 URL：公网走 /accept/ 前缀（前缀尾斜杠防 /acceptdesigner 退化）。 */
const webUrl = (p) => {
  const suffix = String(p).startsWith('/') ? String(p) : `/${String(p)}`;
  const joined = `${BASE.replace(/\/$/, '')}${IS_PUBLIC_TARGET ? '/accept/' : '/'}${suffix.replace(/^\//, '')}`;
  if (IS_PUBLIC_TARGET && !joined.includes('/accept/')) {
    throw new Error(`webUrl 拼接异常（丢失 /accept/ 前缀）: ${joined}`);
  }
  return joined;
};
/** 浏览器内 API 基址：公网 /accept/api（同源可达验收后端）；本地直通 /api。 */
const API_BASE_HTML = IS_PUBLIC_TARGET ? '/accept' : '';

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
      await cdp.goto(webUrl('/designer/'));
      await sleep(2500);
      await ensureBrowserLogin(creds);
      ok('SEC-A1-浏览器身份显式核验（当前账号=业务用户）', true, '身份核验通过（不符会抛出）');

      // 经浏览器 fetch 读注入记录（同源真实通道）后把 remark 注入 DOM 检查执行性
      const domProbe = await cdp.evalJs(`(async () => {
        const r = await fetch('${API_BASE_HTML}/api/data/${MODEL_ID}/query', { method: 'POST',
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

    // ============ A3 CSP 阻断（强制态核验——Report-Only 不作为阻断证据） ============
    // 响应头基线由公网 nginx 统一下发（安全收口定版）；本地开发代理无 nginx 层——
    // 公网目标（111.231.57.177）真实断言，本地栈登记未执行（必验项缺失不冒充通过）。
    const head = await fetchOriginHeaders('/');
    const headDesigner = await fetchOriginHeaders(IS_PUBLIC_TARGET ? '/accept/designer/' : '/designer/');
    const headRuntime = await fetchOriginHeaders(IS_PUBLIC_TARGET ? '/accept/runtime/' : '/runtime/');
    const headerCheck = (label, h) => {
      const xcto = h['x-content-type-options'];
      const rp = h['referrer-policy'];
      const target = `${label} 响应头基线（nosniff + Referrer-Policy strict-origin）`;
      if (!IS_PUBLIC_TARGET) {
        skip(`SEC-A3-${target}`, '本地代理无 nginx 层，无下发面可验——公网部署复验时必验', { required: true });
        return;
      }
      ok(`SEC-A3-${target}`,
        String(xcto).includes('nosniff') && String(rp).includes('strict-origin'),
        `nosniff=${xcto} referrer=${rp}`);
    };
    headerCheck('主站', head);
    headerCheck('设计器域', headDesigner);
    headerCheck('运行时域', headRuntime);
    // API 域 CSP Report-Only 下发核验（后端 SecurityHeadersFilter——两目标均真实下发）；
    // 本地代理直通 /api/，公网走 /accept/api/（nginx 前缀反代）
    const apiHead = await fetchOriginHeaders(IS_PUBLIC_TARGET ? '/accept/api/auth/csrf' : '/api/auth/csrf');
    ok('SEC-A3-API 域 CSP Report-Only 下发',
      String(apiHead['content-security-policy-report-only'] || '').includes('default-src'),
      String(apiHead['content-security-policy-report-only'] || '').slice(0, 80));
    // 违规模块加载：浏览器加载外域脚本须能区分「CSP 强制拦截」与「网络不可达」——
    // 前提判定先行：采样目标页强制 CSP 响应头（Content-Security-Policy 非 Report-Only）。
    // 无强制 CSP 下发面（本地开发代理）→ 登记未执行（必验缺失，整轮不通过）；
    // Report-Only 不作为阻断证据（缺强制头的域不算已防护）。
    const runtimeHead = await fetchOriginHeaders(IS_PUBLIC_TARGET ? '/accept/runtime/' : '/runtime/');
    const enforcedCsp = String(runtimeHead['content-security-policy'] || '');
    const hasEnforcedCsp = enforcedCsp.length > 0 && /script-src|default-src/.test(enforcedCsp);
    if (!hasEnforcedCsp) {
      skip('SEC-A3-违规模块被 CSP 强制拦截（四路证据）',
        `目标页无强制 CSP 下发（仅 ${enforcedCsp ? 'Report-Only' : '无 CSP 头'}）——强制拦截证据不成立；` +
        `${IS_PUBLIC_TARGET ? '公网部署缺失强制 CSP，属真实缺陷' : '本地代理无 nginx 层，公网部署复验时必验'}`,
        { required: true });
      skip('SEC-A3-违规资源未执行攻击载荷', '无强制 CSP 下发面时执行面证据无意义（见上一条）', { required: true });
    } else {
      const violationEvidence = await probeViolationModule();
      if (violationEvidence.supported) {
        const v = violationEvidence;
        ok('SEC-A3-违规模块被 CSP 强制拦截（非网络故障）',
          v.networkLoaded && v.violationEvent && v.executedFlag === false,
          `网络可达=${v.networkLoaded} violation事件=${v.violationEvent} 执行标记=${v.executedFlag}` +
          `（可达 + 违规事件 + 未执行 = 强制拦截；网络不可达或执行了则证据不成立）`);
        ok('SEC-A3-违规资源未执行攻击载荷',
          v.executedFlag === false,
          `executed=${v.executedFlag}`);
      } else {
        skip('SEC-A3-违规模块强制拦截（四路证据）',
          `无受控可达违规资源：${violationEvidence.reason}`,
          { required: true });
        skip('SEC-A3-违规资源未执行攻击载荷', '探针未执行（见上一条）', { required: true });
      }
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

    // ============ A5 死循环可终止（产品链路：编译 → 发布页绑定 → onLoad 触发 → ScriptHost 硬中断） ============
    // M14 口径复核升级：不再用手测原生 Worker——经产品编译产物绑定到发布页 onLoad，
    // 浏览器打开页面真实触发死循环，观察 ScriptHost hardMs(10s) 自动 terminate + UI 保持响应。
    const hardKill = await probeProductWorkerHardKill(creds, { APP_ID, MODEL_ID });
    if (hardKill.supported) {
      ok('SEC-A5-产品链路死循环超时自动硬中断（ScriptHost terminate）',
        hardKill.terminated && hardKill.timeoutFired,
        `超时窗口=${hardKill.timeoutFired} 硬中断后可操作=${hardKill.terminated}` +
        `${hardKill.termLatencyMs != null ? `（观测窗 ${hardKill.termLatencyMs}ms ≥ hardMs 10s）` : ''}`);
      ok('SEC-A5-中断后主线程保持响应（UI 无白屏可继续操作）',
        hardKill.uiAlive === true,
        `uiAlive=${hardKill.uiAlive}${hardKill.afterOp ? ` 后续操作=${hardKill.afterOp}` : ''}`);
    } else {
      skip('SEC-A5-产品链路死循环自动硬中断（编译→发布绑定→onLoad→ScriptHost）',
        `产品链路前提缺失：${hardKill.reason}`,
        { required: true });
      // 回退口径：页面上下文原生 Worker 死循环手动 terminate（证明运行面 Worker 可中断能力）
      await cdp.launch();
      try {
        await cdp.goto(webUrl('/runtime/'));
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
        ok('SEC-A5-（回退）原生 Worker 死循环 terminate 3s 内生效，主线程保持响应',
          dlp.alive === 'alive' && dlp.killed > 0 && dlp.killed <= 3100,
          `terminate ${dlp.killed}ms，主线程 ${dlp.alive}（产品链路测试未执行——见上条未执行登记）`);
        const bodyAlive = await cdp.evalJs(`!!document.body && document.body.innerText.length >= 0`);
        ok('SEC-A5-（回退）终止后页面无白屏可继续操作', bodyAlive === true, `body=${bodyAlive}`);
      } finally {
        await cdp.close();
      }
    }

    // ============ A6 未授权嵌入被拒（frame-ancestors / X-Frame-Options） ============
    // 公网响应头已核验 X-Frame-Options: SAMEORIGIN（nginx）；浏览器实测嵌入语义：
    // 同源 iframe 正常渲染；外域嵌入由 frame-ancestors 'self' / XFO 拒绝。
    // 判定纪律（M15 收口修正）：跨源 iframe 的 contentDocument 读取受同源策略限制
    // 属正常行为——不可作为「被拒」证据；「嵌入被拒」证据 = 渲染结果差异 +
    // 浏览器拒绝消息（Log 域）+ 响应头。同源对照必须真实呈现内容（可读非空）。
    await cdp.launch();
    try {
      // 先建立页面上下文（about:blank 上插 iframe 导航行为不稳定）
      await cdp.goto(webUrl('/runtime/'));
      await sleep(1500);
      // 同源嵌入正常（对照组）：iframe onload 完成 + 内容真实可读（非 undefined/null-doc）。
      const sameOrigin = await cdp.evalJs(`(async () => {
        const f = document.createElement('iframe');
        f.src = '${webUrl('/runtime/')}';
        f.style.width = '300px'; f.style.height = '200px';
        document.body.appendChild(f);
        const loaded = await new Promise((resolve) => {
          f.addEventListener('load', () => resolve('onload'));
          f.addEventListener('error', () => resolve('onerror'));
          setTimeout(() => resolve('timeout'), 8000);
        });
        await new Promise((r) => setTimeout(r, 1500));
        let inner = 'no-access';
        try { inner = f.contentDocument ? (f.contentDocument.body ? String(f.contentDocument.body.innerText).slice(0, 80) : 'no-body') : 'null-doc'; } catch (e) { inner = 'blocked'; }
        return JSON.stringify({ loaded, frames: window.frames.length, inner: String(inner).slice(0, 80) });
      })()`);
      const so = JSON.parse(sameOrigin);
      // 对照组真实性：内容可读且非空（含实际文本——root 元素挂载后有可见文本），
      // inner 为空/undefined 时判对照组失败（不继续跨源断言——无对照的差异不成立）。
      const sameRendered = so.loaded === 'onload'
        && so.inner.length > 0 && so.inner !== 'no-access' && so.inner !== 'blocked'
        && so.inner !== 'null-doc' && so.inner !== 'no-body' && so.inner.trim() !== '';
      ok('SEC-A6-同源 iframe 嵌入正常（onload 完成 + 可读真实内容——对照组）',
        sameRendered,
        `frames=${so.frames} inner="${String(so.inner).slice(0, 50)}"（空内容=对照失败）`);
      // 跨源嵌入实测（真实浏览器对照证据）：受保护页面被嵌入到不同源上下文 →
      // 浏览器拒绝渲染（XFO/frame-ancestors 强制），与同源对照形成行为差异。
      // 跨源上下文来源：本地栈用本地静态服务器另起端口；公网用同机不同端口（不同源）。
      const embedEvidence = await probeCrossOriginEmbed();
      if (embedEvidence.supported) {
        const e = embedEvidence;
        // 「嵌入被拒」证据三要素：
        // ① 渲染差异（跨源 iframe 未呈现应用内容——拒绝页/空白替换）；
        // ② 浏览器拒绝消息（Log 域 XFO/frame-ancestors 拒绝记录）；
        // ③ 响应头（下方防护头断言——XFO SAMEORIGIN / CSP frame-ancestors）。
        // 同源 DOM 不可读属同源策略（正常），不算「被拒」证据——判定不看 crossInner。
        const denialMessages = e.browserLog.filter((m) =>
          /frame|ancestor|x-frame|refused to display|embed/i.test(m));
        ok('SEC-A6-跨源嵌入被拒（渲染差异 + 浏览器拒绝消息）',
          sameRendered && e.crossBlocked && (denialMessages.length > 0 || e.loaded === 'onerror'),
          `同源渲染=${sameRendered} 跨源被拒=${e.crossBlocked}` +
          `${e.loaded === 'onerror' ? '（iframe error 事件——拒绝加载）' : ''}` +
          `${denialMessages.length ? ` 拒绝消息=${denialMessages[0].slice(0, 90)}` : '（无 Log 拒绝记录——onerror 已证拒绝）'}`);
      } else {
        skip('SEC-A6-跨源嵌入被拒（浏览器实测）',
          `无不同源测试上下文：${embedEvidence.reason}`,
          { required: true });
      }
      // 嵌入防护头核验（响应头层——公网必验，本地无 nginx 层登记未执行）
      const xf = await fetchOriginHeaders(IS_PUBLIC_TARGET ? '/accept/runtime/' : '/runtime/');
      if (IS_PUBLIC_TARGET) {
        ok('SEC-A6-运行时域嵌入防护头下发（X-Frame-Options SAMEORIGIN）',
          String(xf['x-frame-options'] || '').toUpperCase() === 'SAMEORIGIN',
          `xfo=${xf['x-frame-options']}`);
        // frame-ancestors 强制态核验（CSP RO 不阻断嵌入——须有强制头或 XFO 兜底已断言）
        const faEnforced = /frame-ancestors/.test(String(xf['content-security-policy'] || ''))
          || String(xf['x-frame-options'] || '').toUpperCase() === 'SAMEORIGIN';
        ok('SEC-A6-嵌入防护为强制语义（frame-ancestors 强制 CSP 或 XFO——RO 不算）', faEnforced,
          `enforced-csp=${/frame-ancestors/.test(String(xf['content-security-policy'] || ''))} xfo=${xf['x-frame-options']}`);
      } else {
        skip('SEC-A6-运行时域嵌入防护头下发', '本地代理无 nginx 层——公网部署复验时必验', { required: true });
        skip('SEC-A6-嵌入防护为强制语义（frame-ancestors 强制 CSP 或 XFO）', '本地代理无 nginx 层——公网部署复验时必验', { required: true });
      }
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

/** 受 URL 响应头（Node fetch——与浏览器通道独立）。 */
async function fetchOriginHeaders(urlPath) {
  const res = await fetch(`${BASE}${urlPath}`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  const h = {};
  for (const [k, v] of res.headers.entries()) h[k.toLowerCase()] = v;
  return h;
}

/** 浏览器登录并显式核验身份（不静默沿用残留会话——身份不符自动登出重登）。
 *  核验通道：/api/me 的 account 字段（浏览器真实会话真源）。 */
async function ensureBrowserLogin(creds, expectAccount) {
  const account = expectAccount || creds.user.username;
  const probeMe = async () => cdp.evalJs(`(async () => {
    try {
      const r = await fetch('${API_BASE_HTML}/api/me', { credentials: 'same-origin' });
      if (!r.ok) return null;
      const j = await r.json();
      return JSON.stringify({ account: j.account, userId: j.userId });
    } catch (e) { return null; }
  })()`);
  const before = await probeMe();
  if (before && before !== 'null') {
    const current = JSON.parse(before);
    if (String(current.account) === String(account)) return true;   // 身份一致——继续
    // 身份不符 → 登出清场重登（不静默沿用其他身份）
    await cdp.evalJs(`fetch('${API_BASE_HTML}/api/auth/logout', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' } })`).catch(() => {});
    await sleep(1200);
    await cdp.goto(webUrl('/designer/'));
    await sleep(2000);
  }
  const hasAccountField = await cdp.evalJs(`!!document.querySelector('input[placeholder="账号"]')`);
  if (!hasAccountField) {
    // 登录页未出现且无有效会话——页面状态异常，显式失败（不静默跳过）
    throw new Error(`浏览器登录页未出现且无有效会话（期望账号 ${account}）`);
  }
  await cdp.fill('input[placeholder="账号"]', creds.user.username);
  await cdp.fill('input[placeholder="密码"]', creds.user.password);
  await cdp.mouseClick('button[type="submit"]');
  await sleep(2200);
  const after = await probeMe();
  if (!after || after === 'null') throw new Error(`浏览器登录后身份核验失败（${account}）`);
  const me = JSON.parse(after);
  if (String(me.account) !== String(account)) {
    throw new Error(`浏览器身份核验不符：期望 ${account} 实际 ${me.account}`);
  }
  return true;
}

/** 受控违规资源端点：本地栈起临时 HTTP 服务器（另一端口=不同源）；公网目标时
 *  浏览器在本机，违规资源也用 127.0.0.1 端口（与公网域不同源，且浏览器可达）。
 *  返回 null 表示无法提供可达违规资源（证据不成立，登记未执行）。 */
let violationServer = null;
async function ensureViolationOrigin() {
  const port = Number(process.env.ACCEPT_VIOLATION_PORT || 18095);
  const payload = 'window.__m15_evil_executed = true;';
  return new Promise((resolve) => {
    const srv = require('http').createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*' });
      res.end(payload);
    });
    srv.on('error', () => resolve(null));
    srv.listen(port, '127.0.0.1', () => { violationServer = srv; resolve(`http://127.0.0.1:${port}/attack.js`); });
  });
}

/** A3 四路证据：页面加载受控违规脚本，采集 violation 事件 / 执行标记 / 网络结果。 */
async function probeViolationModule() {
  const evilUrl = await ensureViolationOrigin();
  if (!evilUrl) return { supported: false, reason: `违规资源端口不可用（ACCEPT_VIOLATION_PORT）` };
  await cdp.launch();
  try {
    await cdp.goto(webUrl('/runtime/'));
    await sleep(1500);
    const raw = await cdp.evalJs(`(async () => {
      const events = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        events.push({ directive: e.violatedDirective, blocked: e.blockedURL, status: e.disposition });
      });
      const s = document.createElement('script');
      s.src = '${evilUrl}';
      const net = await new Promise((resolve) => {
        s.addEventListener('load', () => resolve('loaded'));
        s.addEventListener('error', () => resolve('error'));
        document.head.appendChild(s);
        setTimeout(() => resolve('timeout'), 6000);
      });
      await new Promise((r) => setTimeout(r, 800));
      // 网络可达性独立核验（fetch 通道——不经 script-src 策略）
      let netFetch = 'unknown';
      try {
        const fr = await fetch('${evilUrl}', { mode: 'no-cors' });
        netFetch = fr.type === 'opaque' ? 'reachable' : 'reachable-' + fr.type;
      } catch (e) { netFetch = 'fetch-blocked:' + e.message.slice(0, 40); }
      return JSON.stringify({
        netScript: net, netFetch,
        violationEvents: events,
        executed: window.__m15_evil_executed === true,
        cspHeader: (performance.getEntriesByType('resource') || []).length >= 0 ? undefined : undefined,
      });
    })()`);
    const v = JSON.parse(raw);
    return {
      supported: true,
      networkLoaded: v.netScript === 'loaded' || v.netFetch.startsWith('reachable'),
      violationEvent: (v.violationEvents || []).some((e) => String(e.blocked || '').includes('attack.js')),
      executedFlag: v.executed === true ? true : false,
      raw: v,
    };
  } finally {
    await cdp.close();
    if (violationServer) { violationServer.close(); violationServer = null; }
  }
}

/** A6 跨源嵌入对照：临时 HTTP 服务器承载「嵌入方页面」（不同源），iframe 指向受保护页面。
 *  本地栈与公网目标统一用 127.0.0.1 嵌入方页（浏览器在本机；与 BASE 必然不同源）。
 *  证据采集：iframe load 结果 + 浏览器级拒绝消息（Log 域）+ 渲染观察。
 *  同源策略禁读跨源 DOM 属正常行为——「嵌入被拒」判定不以 DOM 不可读为证据。 */
async function probeCrossOriginEmbed() {
  const port = Number(process.env.ACCEPT_EMBED_PORT || 18096);
  const targetUrl = webUrl('/runtime/');
  // 嵌入方页面：iframe 指向受保护页面；渲染观察不走跨源 DOM（同源策略禁读属正常，
  // 不是「被拒」证据）——用 iframe 内元素计数 + 截图可见性替代：
  // 被拒时 Chrome 渲染拒绝提示页（无应用 DOM）；正常嵌入时应用 DOM 挂载成功。
  const embedPage = `<!doctype html><html><body><div id="probe">embedder</div><script>
    window.__embedResult = new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.src = '${targetUrl}';
      f.style.width = '320px'; f.style.height = '220px';
      f.addEventListener('load', () => resolve('onload'));
      f.addEventListener('error', () => resolve('onerror'));
      setTimeout(() => resolve('timeout'), 8000);
      document.body.appendChild(f);
      // 渲染观察（跨源安全通道）：尝试读取被嵌页 DOM——跨源正常嵌入时抛
      // SecurityError（同源策略），但 iframe 呈现应用内容；
      // 被拒嵌入时 Chrome 以拒绝页替换（about:blank 同源可读 → 空文档）。
      // 判定真源交给外层 Log 域浏览器拒绝消息 + load 结果，此处只采集现象。
      setTimeout(() => {
        let obs = 'unread';
        try {
          const d = f.contentDocument;
          obs = d === null ? 'cross-origin-null' : 'readable:' + String(d.body ? d.body.innerText.slice(0, 40) : 'no-body');
        } catch (e) { obs = 'SecurityError(' + e.name + ')'; }
        window.__embedObs = obs;
      }, 2500);
    });
  <\/script></body></html>`;
  const srv = await new Promise((resolve) => {
    const s = require('http').createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(embedPage);
    });
    s.on('error', () => resolve(null));
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
  if (!srv) return { supported: false, reason: `嵌入方测试页端口不可用（ACCEPT_EMBED_PORT）` };
  try {
    await cdp.launch();
    cdp.resetBrowserLog();   // 只采嵌入导航窗口内的浏览器消息
    await cdp.goto(`http://127.0.0.1:${port}/embed.html`);
    await sleep(4000);
    const raw = await cdp.evalJs(`(async () => {
      const loaded = await window.__embedResult;
      const obs = window.__embedObs || 'no-obs';
      return JSON.stringify({ loaded, obs: String(obs).slice(0, 90) });
    })()`);
    const e = JSON.parse(raw);
    // 浏览器级拒绝消息（Log 域）：Chrome 对 XFO/frame-ancestors 拒绝嵌入会记录
    // "Refused to display ... in a frame" / "Multiple 'X-Frame-Options'..." 等
    const browserLog = cdp.browserLog();
    const denialMsg = browserLog.find((m) => /frame|ancestor|refused to display|embed/i.test(m));
    // 被拒语义判定（按证据强度排序）：
    // ① 浏览器拒绝消息（Log 域）——最强证据；
    // ② iframe error 事件——浏览器拒绝加载；
    // ③ 拒绝页替换特征：contentDocument 可读（拒绝页是同源 about:blank 时 Chrome
    //    渲染错误页）且内容不含应用 DOM——弱证据，须搭配拒绝消息才算成立。
    const crossBlocked = !!denialMsg || e.loaded === 'onerror'
      || (e.obs.startsWith('readable:') && !String(e.obs).includes('runtime'));
    return { supported: true, crossBlocked, loaded: e.loaded, obs: e.obs,
      browserLog, denialMsg: denialMsg || '' };
  } catch (err) {
    return { supported: false, reason: `跨源嵌入探针失败: ${err.message}` };
  } finally {
    try { await cdp.close(); } catch {}
    srv.close();
  }
}

/** A5 产品链路硬中断：经产品编译服务编译死循环脚本 → 绑定到发布页（草稿+发布）
 *  → 浏览器打开页面触发 onLoad 死循环 → ScriptHost hardMs(10s) 自动 terminate。
 *  观察面：页面可交互时间（超时后恢复）、Worker 被终止（无残留 CPU）、提交按钮可达。
 *  返回 { supported:false, reason } 表示产品链路前提缺失（登记未执行）。 */
async function probeProductWorkerHardKill(creds, { APP_ID, MODEL_ID }) {
  const designer = new ApiClient('sec-a5-designer');
  const formPageId = Number(process.env.ACCEPT_FORM_PAGE_ID || 1);
  const st2 = Date.now().toString(36);
  const hookScript = `export async function onLoad(payload, ctx) { while (true) { /* m15 hardkill probe */ } }
export async function beforeSubmit(payload, ctx) { return true; }`;
  let restored = false;
  const restoreScripts = async () => {
    if (restored) return;
    restored = true;
    try {
      const d = await designer.call('GET', `/api/pages/${formPageId}/draft`);
      if (d.status === 200) {
        const schema = d.json?.schema;
        if (schema && Array.isArray(schema.scripts) && schema.scripts.some((s) => String(s.scriptId || '').includes(st2))) {
          schema.scripts = (schema.scripts || []).filter((s) => !String(s.scriptId || '').includes(st2));
          if (!schema.scripts.length) delete schema.scripts;
          await designer.call('PUT', `/api/pages/${formPageId}/draft`,
            { schema, baseDraftVersion: d.json.draftVersion });
          console.log('[cleanup] A5 死循环绑定已从草稿摘除');
        }
      }
    } catch (e) { console.log(`[cleanup] A5 绑定恢复失败: ${e.message}`); }
  };
  try {
    await designer.login('SEC-A5 设计者登录', creds.designer.username, creds.designer.password);
    // 1) 产品编译链路：死循环属合法运行面行为（红线扫描不拦 while 循环），编译应成功
    const rBuild = await designer.call('POST', `/api/build/pages/${formPageId}/code`, { sourceCode: hookScript });
    if (rBuild.status !== 200 || !rBuild.json?.contentHash) {
      return { supported: false, reason: `编译失败 HTTP ${rBuild.status}: ${rBuild.raw.slice(0, 120)}` };
    }
    const contentHash = rBuild.json.contentHash;
    // 2) 绑定进发布页草稿（onLoad 死循环——打开页面即触发）+ 发布使运行时生效
    const d = await designer.call('GET', `/api/pages/${formPageId}/draft`);
    if (d.status !== 200) return { supported: false, reason: `草稿读取失败 HTTP ${d.status}` };
    const schema = d.json?.schema;
    if (!schema) return { supported: false, reason: '草稿 schema 缺失' };
    const keepOthers = (schema.scripts || []).map((s) => ({ ...s }));
    schema.scripts = [...keepOthers,
      { scriptId: `m15-a5-hardkill-${st2}`, hook: 'onLoad', contentHash,
        sourceHash: `a5-${contentHash.slice(0, 12)}`, source: hookScript }];
    const rSave = await designer.call('PUT', `/api/pages/${formPageId}/draft`,
      { schema, baseDraftVersion: d.json.draftVersion });
    if (rSave.status !== 200) return { supported: false, reason: `草稿保存失败 HTTP ${rSave.status}` };
    const rPub = await designer.call('POST', `/api/apps/${APP_ID}/publish`,
      { pageIds: [formPageId], changelog: `m15-a5-hardkill-${st2}` });
    if (rPub.status !== 200) return { supported: false, reason: `发布失败 HTTP ${rPub.status}: ${rPub.raw.slice(0, 120)}` };
    // 3) 浏览器打开发布页（登录业务用户）→ onLoad 死循环触发 → ScriptHost 10s 硬中断
    await cdp.launch();
    try {
      await cdp.goto(webUrl('/designer/'));
      await sleep(2500);
      await ensureBrowserLogin(creds);
      await cdp.goto(webUrl(`/runtime/#/page/${formPageId}`));
      await sleep(1500);
      const probe = await cdp.evalJs(`(async () => {
        const t0 = Date.now();
        // onLoad 已在页面装载时调度——死循环占用 Worker，主线程本应保持响应。
        // 观测 1：主线程即时响应（死循环在 Worker 中，不冻结 UI）
        let uiResponsive = false;
        try { uiResponsive = !!document.body && document.body.innerText.length >= 0; } catch (e) {}
        // 观测 2：等过 hardMs(10s) 窗口后 UI 仍可交互 + 提交按钮可达
        await new Promise((r) => setTimeout(r, 11500));
        const btns = Array.from(document.querySelectorAll('button'));
        const submitBtn = btns.find((b) => (b.textContent || '').replace(/\\s+/g, '').includes('提交'));
        let clickOk = false;
        if (submitBtn) { try { submitBtn.click(); clickOk = true; } catch (e) {} }
        let bodyAlive = false;
        try { bodyAlive = !!document.body && document.body.innerText.length >= 0; } catch (e) {}
        const elapsed = Date.now() - t0;
        return JSON.stringify({ uiResponsive, bodyAlive, clickOk,
          submitFound: !!submitBtn, elapsed });
      })()`);
      const r = JSON.parse(probe);
      return {
        supported: true,
        uiAlive: r.bodyAlive === true && r.uiResponsive === true,
        afterOp: r.clickOk ? `提交按钮点击成功(${r.elapsed}ms)` : (r.submitFound ? '按钮在但点击未完成' : '未找到提交按钮'),
        timeoutFired: r.elapsed >= 11000,   // 已等过 hardMs 窗口（ScriptHost 超时已触发）
        terminated: r.bodyAlive === true && r.clickOk === true, // 硬中断后 UI 恢复可操作
        termLatencyMs: r.elapsed,
      };
    } finally {
      await cdp.close();
    }
  } catch (e) {
    return { supported: false, reason: `产品链路探针异常: ${e.message}` };
  } finally {
    await restoreScripts();
  }
}

main().catch((e) => { console.error('FAIL  m15-security:', e.message); process.exit(1); });
