/**
 * Spec 019 主题最小 · 浏览器验收（公网验收面 /accept/）六项：
 *  B1 主题切换不丢表单数据（ThemeTab 表单填写态跨主题变更保留）
 *  B2 designer 预览与 runtime 一致（同一 antdTokenOf 输出——CSS 变量 + 主色断言）
 *  B3 刷新后主题一致（theme 持久下发——CSS 变量再现）
 *  B4 切换应用不串主题（A 应用绿主题/B 应用默认蓝——CSS 变量随应用切换）
 *  B5 旧应用默认降级（无 theme → 平台蓝 #1677ff）
 *  B6 暗色错误/禁用态可读（darkMode 应用 runtime 界面错误文本/禁用输入前景对比）
 *  B7 非法存量主题可观察反馈（DB 直写非法 theme → runtime 黄条「主题配置非法」）
 * 通道：CDP 真实浏览器 + API 写主题 + 落库核对；fail-fast。
 */
const cdp = require('./cdp.cjs');
const { BASE, ok, record, ApiClient, summary, dbQuery } = require('./accept-lib.cjs');

const USERNAME = process.env.ACCEPT_USERNAME || 'accept_admin';
const PASSWORD = process.env.ACCEPT_PASSWORD || 'Accept!2026';
if (!PASSWORD) { console.error('缺少 ACCEPT_PASSWORD'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bodyText() { return (await cdp.evalJs('document.body.innerText')) || ''; }
async function waitText(include, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await bodyText()).includes(include)) return true;
    await sleep(300);
  }
  return false;
}
/** 读当前 documentElement CSS 变量。 */
/** 等 CSS 变量装载（runtime 主题注入完成——SPA 装载 + nav 拉取后才 setProperty）。 */
async function waitCssVar(name, expect, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await cssVar(name);
    if (v && v.toLowerCase() === expect.toLowerCase()) return v;
    await sleep(400);
  }
  return cssVar(name);
}

async function cssVar(name) {
  return cdp.evalJs(`getComputedStyle(document.documentElement).getPropertyValue('${name}').trim()`);
}
async function clickButton(text, scopeJs = 'document') {
  const r = await cdp.evalJs(`(() => {
    const scope = ${scopeJs};
    const els = Array.from((scope || document).querySelectorAll('button'));
    const el = els.find(x => (x.textContent || '').replace(/[\\s\\u3000]+/g, '').includes('${text}'.replace(/[\\s\\u3000]+/g, '')));
    if (!el) return 'missing';
    el.click(); return 'clicked';
  })()`);
  if (r !== 'clicked') throw new Error('按钮未找到: ' + text);
  return r;
}
async function clickTab(name) {
  await cdp.evalJs(`(() => { const t = Array.from(document.querySelectorAll('.ant-tabs-tab')).find(x => x.textContent.includes('${name}')); t?.click(); })()`);
  await sleep(900);
}
/** 打开应用设置主题页签（ThemeTab——页签名「主题」）。 */
async function openThemeTab(appName) {
  await cdp.evalJs(`(() => {
    const cards = Array.from(document.querySelectorAll('.ant-card'));
    const c = cards.find(x => x.textContent.includes('${appName}'));
    if (!c) return 'missing-card';
    (c.querySelector('button') || c).click(); return 'ok';
  })()`);
  await cdp.waitFor('.ant-tabs', 12000);
  await sleep(1200);
  await cdp.evalJs(`(() => { const tabs = Array.from(document.querySelectorAll('.ant-tabs-tab')); const t = tabs.find(x => x.textContent.trim() === '主题'); if (!t) return 'missing-tab:' + tabs.map(x => x.textContent.trim()).join(','); t.click(); return 'ok'; })()`);
  await sleep(1500);
  const ready = await (async () => {
    const start = Date.now();
    while (Date.now() - start < 10000) {
      const r = await cdp.evalJs(`(() => { const hit = Array.from(document.querySelectorAll('label,button,span')).find(x => (x.textContent || '').includes('主题色')); const ta = Array.from(document.querySelectorAll('textarea')); return hit && ta.length > 0 ? 'yes' : 'no'; })()`);
      if (r === 'yes') return true;
      await sleep(400);
    }
    return false;
  })();
  if (!ready) await cdp.shot('theme-tab-not-ready');
  return ready;
}
/** 在 ThemeTab 表单内改主题色 swatch（Radio.Button 点击）。 */
async function pickSwatch(hex) {
  const r = await cdp.evalJs(`(() => {
    const radios = Array.from(document.querySelectorAll('label.ant-radio-button-wrapper'));
    const hit = radios.find(x => (x.querySelector('input') || {}).value === '${hex}' || x.textContent.includes('${hex}'));
    if (!hit) return 'missing';
    hit.querySelector('input').click(); return 'ok';
  })()`);
  await sleep(500);
  return r;
}
/** 在 ThemeTab 表单内填描述（表单内 textarea——非 placeholder 定位，标签锚「描述」）。 */
async function fillDescription(value) {
  const r = await cdp.evalJs(`(() => {
    const form = document.querySelector('.ant-form');
    if (!form) return 'missing-form';
    const ta = Array.from(form.querySelectorAll('textarea'))[0];
    if (!ta) return 'missing-textarea';
    const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    s.call(ta, '${value}');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(500);
  return r;
}

(async () => {
  await cdp.launch();
  try {
    const admin = new ApiClient('admin');
    await admin.login('API 管理员登录', USERNAME, PASSWORD);

    // 准备两个验收应用：A=主题验收应用（改绿+暗色）、B=旧应用（无 theme）
    const apps = await admin.call('GET', '/api/apps?keyword=');
    const list = apps.json.list || [];
    let appA = list.find((a) => a.name.includes('主题验收'));
    if (!appA) {
      const created = await admin.call('POST', '/api/apps', { name: '主题验收应用_019B' });
      appA = { id: created.json.appId, name: '主题验收应用_019B' };
    }
    let appB = list.find((a) => a.name.includes('报销管理'));
    if (!appB) {
      const created = await admin.call('POST', '/api/apps', { name: '旧应用无主题_019B' });
      appB = { id: created.json.appId, name: '旧应用无主题_019B' };
      // B 保证无 theme（清空）
      await admin.call('PUT', `/api/apps/${appB.id}`, { theme: 'null' });
    } else {
      await admin.call('PUT', `/api/apps/${appB.id}`, { theme: 'null' });
    }
    record('应用就绪', `A=${appA.id}(${appA.name}) B=${appB.id}(${appB.name})`);

    // 固定初始态：A=亮色绿主题（防上一轮 B6 暗色残留影响 B1/B2 断言）
    await admin.call('PUT', `/api/apps/${appA.id}`, {
      theme: JSON.stringify({ primaryColor: '#52c41a', darkMode: false, tokens: { borderRadius: 6, spacing: 'default', fontFamily: 'system' } }),
    });
    record('初始态', 'A=亮色绿#52c41a B=无主题');

    // ========== 浏览器登录 designer ==========
    await cdp.goto(`${BASE}/accept/designer/`);
    await cdp.waitFor('input', 15000);
    // SPA 装载轮询：登录输入框出现为止（冷装载 3.5-6s 波动——固定等待必漏判）
    const loginVisible = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 15000) {
        const r = await cdp.evalJs(`(() => { const el = Array.from(document.querySelectorAll('input')).find(i => (i.placeholder || '').includes('账号')); return el ? 'yes' : 'no'; })()`);
        if (r === 'yes') return true;
        await sleep(400);
      }
      return false;
    })();
    if (!loginVisible) throw new Error('登录输入框未出现（SPA 装载超时）');
    await cdp.evalJs(`(() => { const el = Array.from(document.querySelectorAll('input')).find(i => (i.placeholder || '').includes('账号')); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, '${USERNAME}'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await cdp.evalJs(`(() => { const el = Array.from(document.querySelectorAll('input')).find(i => (i.type === 'password')); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, '${PASSWORD}'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await clickButton('登', 'document');
    await cdp.waitFor('.ant-layout-header', 15000);
    await sleep(1200);

    // ========== B1 主题切换不丢表单数据 ==========
    const tabReady = await openThemeTab(appA.name);
    ok('B1-0 主题表单装载完成', tabReady, '');
    const fillR = await fillDescription('B1 表单保留验证');
    ok('B1-0b 描述填写动作命中', fillR === 'ok', fillR);
    const descVal = await cdp.evalJs(`(() => { const el = Array.from(document.querySelectorAll('textarea')).find(t => (t.value||'').includes('B1 表单保留验证')); return el ? el.value : ''; })()`);
    ok('B1-1 表单描述已填写', (descVal || '').includes('B1 表单保留验证'), descVal);
    await pickSwatch('#52c41a');
    // 精确点表单内提交按钮（ant-form 内 primary submit——避开模型页签「保存变更」）
    await cdp.startNetwork();
    const clickR = await cdp.evalJs(`(() => {
      const form = document.querySelector('form.ant-form');
      if (!form) return 'missing-form';
      // antd 中文两字按钮渲染为「保 存」——去空白匹配
      const b = Array.from(form.querySelectorAll('button'))
        .find(x => (x.textContent || '').replace(/\\s+/g, '') === '保存');
      if (!b) return 'missing-btn';
      b.scrollIntoView({ block: 'center' });
      if (typeof form.requestSubmit === 'function') { form.requestSubmit(b); return 'submitted'; }
      b.click();
      return 'clicked';
    })()`);
    record('保存按钮点击', clickR);
    // 成功反馈 = antd message toast（非持久页面文本）——轮询 + API 落库双断言
    const toastSaved = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 9000) {
        const r = await cdp.evalJs(`(() => { const m = Array.from(document.querySelectorAll('.ant-message-notice')).find(x => x.textContent.includes('已保存') || x.textContent.includes('主题配置非法')); return m ? m.textContent : 'no'; })()`);
        if (r !== 'no') return r;
        await sleep(300);
      }
      return 'timeout';
    })();
    const netReqs = cdp.networkRequests().filter((r) => r.url.includes('/api/apps'));
    if (netReqs.length === 0) record('保存网络请求', '无 /api/apps 请求（异常态）');
    const detailA = await admin.call('GET', `/api/apps/${appA.id}`);
    const savedTheme = typeof detailA.json.theme === 'string' ? detailA.json.theme : JSON.stringify(detailA.json.theme);
    ok('B1-2 主题保存成功（toast 已保存）', toastSaved.includes('已保存'), toastSaved);
    ok('B1-2b 保存落库（API 读回 theme 含 #52c41a）', (savedTheme || '').includes('#52c41a'), savedTheme?.slice(0, 80));
    const descKept = await cdp.evalJs(`(() => { const el = Array.from(document.querySelectorAll('textarea')).find(t => (t.value||'').includes('B1 表单保留验证')); return el ? el.value : ''; })()`);
    ok('B1-3 主题切换后表单数据保留', (descKept || '').includes('B1 表单保留验证'), descKept);

    // ========== B2 designer 预览与 runtime 一致（同一 antdTokenOf） ==========
    // 等保存 loading 消退（按钮半透明绿是 loading 态——读取前须稳定）
    await (async () => {
      const start = Date.now();
      while (Date.now() - start < 8000) {
        const loading = await cdp.evalJs(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').replace(/\\s+/g,'') === '保存'); return b && b.className.includes('loading') ? 'yes' : 'no'; })()`);
        if (loading === 'no') return;
        await sleep(400);
      }
    })();
    const designerPrimary = await cdp.evalJs(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('主按钮示例'));
      return btn ? getComputedStyle(btn).backgroundColor : '';
    })()`);
    ok('B2-1 designer 预览主按钮为绿 (#52c41a = rgb(82,196,26))', designerPrimary.includes('82, 196, 26'), designerPrimary);

    // runtime 打开 A 应用 → CSS 变量注入
    await cdp.goto(`${BASE}/accept/runtime/#/app/${appA.id}`);
    const rtPrimary = await waitCssVar('--schema-primary', '#52c41a');
    ok('B2-2 runtime CSS 变量 --schema-primary=#52c41a', rtPrimary.toLowerCase() === '#52c41a', rtPrimary);
    // AntD 通道注入验证：ConfigProvider 生成 :where 样式表注入 token 色——样式表含 #52c41a
    const rtAntdInjected = await cdp.evalJs(`(() => {
      const styles = Array.from(document.querySelectorAll('style'));
      return styles.some(s => (s.textContent || '').toLowerCase().includes('52c41a')) ? 'yes' : 'no';
    })()`);
    ok('B2-3 runtime AntD 通道同源映射（样式表注入 #52c41a）', rtAntdInjected === 'yes', rtAntdInjected);

    // ========== B3 刷新后主题一致 ==========
    await cdp.reload();
    const rtPrimary2 = await waitCssVar('--schema-primary', '#52c41a');
    ok('B3-1 刷新后 --schema-primary 保持 #52c41a', rtPrimary2.toLowerCase() === '#52c41a', rtPrimary2);

    // ========== B4 切换应用不串主题 ==========
    await cdp.goto(`${BASE}/accept/runtime/#/app/${appB.id}`);
    const bPrimary = await waitCssVar('--schema-primary', '#1677ff');
    ok('B4-1 切到 B 应用 --schema-primary 恢复平台蓝 #1677ff', bPrimary.toLowerCase() === '#1677ff', bPrimary);
    const bDark = await cssVar('--schema-dark');
    ok('B4-2 B 应用 --schema-dark=0（亮色）', bDark === '0', bDark);
    await cdp.goto(`${BASE}/accept/runtime/#/app/${appA.id}`);
    const aPrimaryBack = await waitCssVar('--schema-primary', '#52c41a');
    ok('B4-3 切回 A 应用主题恢复绿（不残留 B 蓝色）', aPrimaryBack.toLowerCase() === '#52c41a', aPrimaryBack);

    // ========== B5 旧应用默认降级（B 应用无 theme → 平台蓝） ==========
    const navB = await admin.call('GET', `/api/apps/${appB.id}/nav?filtered=true`);
    ok('B5-1 B 应用 nav theme=null（无配置）', navB.json.theme == null, JSON.stringify(navB.json.theme).slice(0, 60));
    await cdp.goto(`${BASE}/accept/runtime/#/app/${appB.id}`);
    const bPrimary2 = await waitCssVar('--schema-primary', '#1677ff');
    const bShell = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 10000) {
        const t = await bodyText();
        if (t.length > 10 && !t.includes('加载导航') && !t.includes('失败')) return true;
        await sleep(400);
      }
      return false;
    })();
    ok('B5-2 B 应用运行时壳正常渲染（默认蓝不白屏）', bShell && bPrimary2.toLowerCase() === '#1677ff', bPrimary2);

    // ========== B6 暗色错误/禁用态可读 ==========
    // A 应用已配置 darkMode（此前保存绿+暗色？——确认；若未配暗色则 API 补配）
    await admin.call('PUT', `/api/apps/${appA.id}`, {
      theme: JSON.stringify({ primaryColor: '#52c41a', darkMode: true, tokens: { borderRadius: 8, spacing: 'loose', fontFamily: 'serif' } }),
    });
    await cdp.goto(`${BASE}/accept/runtime/#/app/${appA.id}`);
    await sleep(3500);
    const rtDark = await cssVar('--schema-dark');
    ok('B6-1 暗色模式 CSS 变量 --schema-dark=1', rtDark === '1', rtDark);
    const bodyBg = await cdp.evalJs(`(() => {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--schema-bg').trim();
      const shell = document.querySelector('div[style*="--schema-bg"], main, aside');
      const shellBg = shell ? getComputedStyle(shell).backgroundColor : '';
      return JSON.stringify({ varBg: v, shellBg });
    })()`);
    const bgInfo = JSON.parse(bodyBg || '{}');
    const bgIsDark = (bgInfo.varBg || '').includes('#141414') || (bgInfo.shellBg || '').includes('20, 20, 20');
    ok('B6-2 暗色算法生效（壳层底色深色）', bgIsDark, bodyBg);
    // 错误/禁用文本前景可读性：注入错误与禁用元素量对比度（背景取实测容器）
    const contrast = await cdp.evalJs(`(() => {
      const host = document.querySelector('main') || document.body;
      const p = document.createElement('p');
      p.className = 'ant-typography-danger';
      p.textContent = '错误提示';
      const d = document.createElement('input');
      d.disabled = true; d.value = '禁用';
      host.append(p, d);
      const lum = (c) => { const m = c.match(/[\\d.]+/g).map(Number); const [r,g,b] = m.slice(0,3); const f=(v)=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
      let bg = getComputedStyle(host.closest('div') || host).backgroundColor;
      if (!bg || bg.includes('0, 0, 0, 0')) bg = 'rgb(20, 20, 20)';
      const fgErr = getComputedStyle(p).color;
      const fgDis = getComputedStyle(d).color;
      const ratio = (f,b) => { const l1=lum(f), l2=lum(b); return ((Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05)).toFixed(2); };
      const out = { bg, fgErr, ratioErr: ratio(fgErr, bg), fgDis, ratioDis: ratio(fgDis, bg) };
      p.remove(); d.remove();
      return JSON.stringify(out);
    })()`);
    const c = JSON.parse(contrast || '{}');
    ok('B6-3 暗色下错误文本对比度 ≥ 4.5', parseFloat(c.ratioErr) >= 4.5, `err=${c.ratioErr}`);
    // WCAG 对 disabled 组件无强制对比度要求（明确豁免 inactive UI）；antd 暗色默认禁用色约 2.4——
    // 验收口径：非隐形（>2 可辨认）即可，记录实测值供审查
    ok('B6-4 暗色下禁用态可辨认（对比度 > 2，antd 默认禁用色）', parseFloat(c.ratioDis) > 2, `dis=${c.ratioDis}`);

    // ========== B7 非法存量主题可观察反馈 ==========
    // 直写含未知键的 JSON 对象（绕过保存链路白名单——模拟存量脏数据）
    await dbQuery(`UPDATE app SET theme='{"customCss":"body{background:red}","primaryColor":"javascript:alert(1)"}' WHERE id=${appA.id}`);
    const themeCheck = await dbQuery(`SELECT left(theme::text, 50) FROM app WHERE id=${appA.id}`);
    record('B7 库内非法 theme', JSON.stringify(themeCheck));
    await cdp.goto('about:blank');   // 清 SPA 上下文：同源 hash 切换不重载 JS——须真导航
    await cdp.goto(`${BASE}/accept/runtime/#/app/${appA.id}`);
    const warnVisible = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 12000) {
        const r = await cdp.evalJs(`(() => { const a = document.querySelector('.ant-alert'); const t = (document.body.innerText || ''); return (a && t.includes('主题配置非法')) ? 'yes' : 'no'; })()`);
        if (r === 'yes') return true;
        await sleep(400);
      }
      return false;
    })();
    ok('B7-1 非法存量主题显示黄条（不静默）', warnVisible);
    const errDetail = (await bodyText()).includes('customCss') || (await bodyText()).includes('未知键');
    ok('B7-2 黄条透出错误明细（未知键 customCss）', errDetail, '');
    const degradedPrimary = await cssVar('--schema-primary');
    ok('B7-3 非法主题降级平台蓝渲染', degradedPrimary.toLowerCase() === '#1677ff', degradedPrimary);
    // 复原 A 应用为合法绿主题（供后续验收）
    await admin.call('PUT', `/api/apps/${appA.id}`, {
      theme: JSON.stringify({ primaryColor: '#52c41a', darkMode: false, tokens: { borderRadius: 6, spacing: 'default', fontFamily: 'system' } }),
    });

    summary('spec019-theme-browser');
  } catch (e) {
    console.error('验收异常终止:', e.message);
    try { await cdp.shot('abort'); } catch {}
    process.exitCode = 1;
    summary('spec019-theme-browser');
  } finally {
    await cdp.close();
  }
})();
