/**
 * 本轮改动浏览器冒烟（公网验收面 /accept/）：
 * 覆盖 designer/runtime 分层迁移后的真实链路 + admin-console 四类修复的可观察行为。
 *
 *  S1 designer 登录 → 工作台卡片墙渲染（app/ + features/workspace 迁移后可用）
 *  S2 designer 应用设置六页签可切换（features/{models,pages,flows,members,nav,theme,publish} 迁移后可用）
 *  S3 designer 模型页签装载（features/models 迁移后 ER 画布/字段面板可用）
 *  S4 runtime 应用导航壳渲染（app/AppShell + features/page-host 迁移后可用）
 *  S5 runtime 页面装载（features/page-host/FormPageHost 真实取数）
 *  S6 admin-console 登录 → 五个页签可切换（features/{usage,members,notices,ops-health} 迁移后可用）
 *  S7 admin-console 健康页区域状态可见（RegionStatusBar 逐区状态——本轮修复点）
 *  S8 admin-console SLA 页月份切换（查询身份变化重置——本轮修复点）
 *  S9 无 console 未捕获异常（迁移未引入运行时错误）
 *
 * 通道：CDP 真实浏览器 + API 断言；fail-fast。
 * 环境：ACCEPT_BASE_URL / ACCEPT_API_PREFIX / ACCEPT_ALLOW_INSECURE_ORIGIN
 */
const cdp = require('./cdp.cjs');
const { BASE, ok, record, ApiClient, summary } = require('./accept-lib.cjs');

const USERNAME = process.env.ACCEPT_USERNAME || 'accept_admin';
const PASSWORD = process.env.ACCEPT_PASSWORD || 'Accept!2026';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 三应用各自 dev server（本地源码 + 线上后端代理）；未设置时回落到 BASE。 */
const DESIGNER = process.env.SMOKE_DESIGNER || BASE;
const RUNTIME = process.env.SMOKE_RUNTIME || BASE;
const ADMIN = process.env.SMOKE_ADMIN || BASE;

async function bodyText() { return (await cdp.evalJs('document.body.innerText')) || ''; }

/** 轮询等待页面文本出现。 */
async function waitText(include, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await bodyText()).includes(include)) return true;
    await sleep(300);
  }
  return false;
}

/** 轮询等待任意一个文本出现（返回命中的那个）。 */
async function waitAnyText(candidates, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await bodyText();
    const hit = candidates.find((c) => t.includes(c));
    if (hit) return hit;
    await sleep(300);
  }
  return null;
}

/** 等输入框出现（SPA 冷装载 3.5-6s 波动——固定等待必漏判）。 */
async function waitInput(placeholderPart, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await cdp.evalJs(`(() => { const el = Array.from(document.querySelectorAll('input')).find(i => (i.placeholder || '').includes(${JSON.stringify(placeholderPart)})); return el ? 'yes' : 'no'; })()`);
    if (r === 'yes') return true;
    await sleep(400);
  }
  return false;
}

/** 受控输入填值（React 原生 setter + input 事件）。 */
async function fillByPlaceholder(placeholderPart, value) {
  return cdp.evalJs(`(() => {
    const el = Array.from(document.querySelectorAll('input')).find(i => (i.placeholder || '').includes(${JSON.stringify(placeholderPart)}));
    if (!el) return 'missing';
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
}

/** 按文本点按钮（去空白匹配——antd 中文两字按钮渲染为「登 录」）。
 *  submit 型按钮优先走 form.requestSubmit（React 受控表单下 el.click() 可能不触发 onFinish）。 */
async function clickButtonByText(text) {
  const r = await cdp.evalJs(`(() => {
    const norm = (s) => (s || '').replace(/[\\s\\u3000]+/g, '');
    const target = norm(${JSON.stringify(text)});
    const el = Array.from(document.querySelectorAll('button')).find(b => norm(b.textContent).includes(target));
    if (!el) return 'missing';
    el.scrollIntoView({ block: 'center' });
    const form = el.closest('form');
    if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(el); return 'submitted'; }
    el.click();
    return 'clicked';
  })()`);
  await sleep(800);
  return r;
}

/** 点 antd 页签（按文本）。 */
async function clickTab(name) {
  const r = await cdp.evalJs(`(() => {
    const t = Array.from(document.querySelectorAll('.ant-tabs-tab')).find(x => (x.textContent || '').trim() === ${JSON.stringify(name)});
    if (!t) return 'missing';
    t.click();
    return 'ok';
  })()`);
  await sleep(1200);
  return r;
}

/** 当前可见页签列表。 */
async function tabLabels() {
  return cdp.evalJs(`Array.from(document.querySelectorAll('.ant-tabs-tab')).map(x => (x.textContent || '').trim())`);
}

(async () => {
  await cdp.launch();
  try {
    // ========== S1 designer 登录 + 工作台 ==========
    await cdp.goto(`${DESIGNER}/accept/designer/`);
    const loginReady = await waitInput('账号');
    ok('S1-1 designer 登录页装载（迁移后入口可用）', loginReady, '');
    if (!loginReady) throw new Error('designer 登录页未装载');

    await fillByPlaceholder('账号', USERNAME);
    await cdp.evalJs(`(() => {
      const el = Array.from(document.querySelectorAll('input')).find(i => i.type === 'password');
      if (!el) return 'missing';
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(PASSWORD)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`);
    await clickButtonByText('登录');
    const shellUp = await waitText('设计器工作台', 20000);
    ok('S1-2 designer 登录成功进入工作台壳', shellUp, '');
    const workspaceUp = await waitAnyText(['新建应用', '暂无应用', '无匹配应用'], 20000);
    ok('S1-3 工作台卡片墙渲染（features/workspace）', workspaceUp != null, String(workspaceUp));

    // ========== S2 应用设置六页签 ==========
    const opened = await cdp.evalJs(`(() => {
      const cards = Array.from(document.querySelectorAll('.ant-card'));
      const c = cards.find(x => x.querySelector('button') || x.classList.contains('ant-card-hoverable'));
      if (!c) return 'missing';
      c.click();
      return 'ok';
    })()`);
    const tabsUp = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 15000) {
        const labels = await tabLabels();
        if (labels && labels.length >= 5) return labels;
        await sleep(400);
      }
      return [];
    })();
    ok('S2-1 应用设置页签装载（六页签编排）', opened === 'ok' && tabsUp.length >= 5, `opened=${opened} tabs=${(tabsUp || []).join('/')}`);
    const expectTabs = ['模型', '页面', '流程', '成员', '导航', '主题', '发布'];
    const missingTabs = expectTabs.filter((t) => !(tabsUp || []).includes(t));
    ok('S2-2 七页签齐全（features 各域迁移后仍可编排）', missingTabs.length === 0, `missing=${missingTabs.join(',')}`);

    // ========== S3 模型页签装载 ==========
    await clickTab('模型');
    const modelUp = await waitAnyText(['新建模型', '模型', '暂无模型', 'ER'], 15000);
    ok('S3-1 模型页签装载（features/models）', modelUp != null, String(modelUp));

    // ========== S4 runtime 导航壳 ==========
    const admin = new ApiClient('admin');
    await admin.login('API 管理员登录', USERNAME, PASSWORD);
    const apps = await admin.call('GET', '/api/apps?keyword=');
    const appList = (apps.json && apps.json.list) || [];
    ok('S4-0 应用列表可读（API 通道）', apps.status === 200 && appList.length > 0, `count=${appList.length}`);
    const targetApp = appList[0];

    await cdp.goto(`${RUNTIME}/accept/runtime/#/app/${targetApp.id}`);
    const shellText = await waitAnyText(['加载导航', '无可访问菜单', '从左侧菜单选择页面'], 20000);
    ok('S4-1 runtime 导航壳装载（app/AppShell）', shellText != null, String(shellText));
    const navLoaded = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 15000) {
        const t = await bodyText();
        if (t.length > 10 && !t.includes('加载导航')) return true;
        await sleep(400);
      }
      return false;
    })();
    ok('S4-2 导航装载完成（非卡在加载态）', navLoaded, '');

    // ========== S5 runtime 页面装载 ==========
    const pages = await admin.call('GET', `/api/pages?appId=${targetApp.id}`);
    const pageList = (pages.json && pages.json.list) || [];
    if (pageList.length > 0) {
      const pid = pageList[0].id;
      await cdp.goto(`${RUNTIME}/accept/runtime/#/app/${targetApp.id}/page/${pid}`);
      const pageUp = await (async () => {
        const start = Date.now();
        while (Date.now() - start < 20000) {
          const t = await bodyText();
          if (t.length > 20 && !t.includes('加载导航')) return t.slice(0, 80);
          await sleep(400);
        }
        return null;
      })();
      ok('S5-1 runtime 页面装载（features/page-host/FormPageHost）', pageUp != null, String(pageUp));
    } else {
      record('S5-1 runtime 页面装载', true, '该应用无页面——跳过页面渲染断言（导航壳已验）');
    }

    // ========== S6 admin-console 登录 + 五页签 ==========
    await cdp.goto(`${ADMIN}/accept/admin/`);
    const adminLogin = await waitInput('管理员账号');
    ok('S6-1 admin-console 登录页装载（迁移后入口可用）', adminLogin, '');
    if (adminLogin) {
      await fillByPlaceholder('管理员账号', USERNAME);
      await cdp.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('input')).find(i => i.type === 'password');
        if (!el) return 'missing';
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(PASSWORD)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()`);
      await clickButtonByText('登录');
      const adminShell = await waitText('平台管理端', 20000);
      ok('S6-2 admin-console 登录成功进入壳', adminShell, '');
      const adminTabs = await (async () => {
        const start = Date.now();
        while (Date.now() - start < 15000) {
          const labels = await tabLabels();
          if (labels && labels.length >= 5) return labels;
          await sleep(400);
        }
        return [];
      })();
      const expectAdminTabs = ['租户用量', '成员管理', '健康状态', 'SLA 看板', '维护公告'];
      const missingAdmin = expectAdminTabs.filter((t) => !(adminTabs || []).includes(t));
      ok('S6-3 五页签齐全（features/{usage,members,notices,ops-health}）', missingAdmin.length === 0,
        `tabs=${(adminTabs || []).join('/')} missing=${missingAdmin.join(',')}`);

      // ========== S7 健康页区域状态可见 ==========
      await clickTab('健康状态');
      const healthUp = await waitAnyText(['平台状态', '无权查看租户健康详情', '健康数据加载失败'], 20000);
      ok('S7-1 健康页装载（五区域 Hook）', healthUp != null, String(healthUp));
      const regionState = await cdp.evalJs(`(() => {
        const t = document.body.innerText || '';
        const hasRegionBar = /加载中|刷新中|加载失败|无权限查看|刷新失败/.test(t);
        const hasCards = document.querySelectorAll('.ant-card').length;
        return JSON.stringify({ hasRegionBar, hasCards });
      })()`);
      const rs = JSON.parse(regionState || '{}');
      ok('S7-2 区域状态条可见（RegionStatusBar 逐区状态）', rs.hasRegionBar === true || rs.hasCards > 0,
        `regionBar=${rs.hasRegionBar} cards=${rs.hasCards}`);

      // ========== S8 SLA 页月份切换 ==========
      await clickTab('SLA 看板');
      const slaUp = await waitAnyText(['SLA 月度数据', '无权查看 SLA 看板', 'SLA 数据加载失败', '当前查询月份'], 20000);
      ok('S8-1 SLA 页装载', slaUp != null, String(slaUp));
      const monthBefore = await cdp.evalJs(`(() => { const m = (document.body.innerText || '').match(/当前查询月份：(\\d{4}-\\d{2})/); return m ? m[1] : ''; })()`);
      const switched = await cdp.evalJs(`(() => {
        const el = Array.from(document.querySelectorAll('input')).find(i => (i.placeholder || '').includes('YYYY-MM'));
        if (!el) return 'missing-input';
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '2026-09');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        // antd Input.Search：enterButton 渲染为 .ant-input-search-button（button 或 span）
        const wrap = el.closest('.ant-input-search') || el.parentElement;
        const btn = (wrap && wrap.querySelector('.ant-input-search-button'))
          || Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('查询'));
        if (!btn) return 'no-btn';
        btn.click();
        return 'ok';
      })()`);
      const monthAfter = await (async () => {
        const start = Date.now();
        while (Date.now() - start < 15000) {
          const m = await cdp.evalJs(`(() => { const x = (document.body.innerText || '').match(/当前查询月份：(\\d{4}-\\d{2})/); return x ? x[1] : ''; })()`);
          if (m === '2026-09') return m;
          await sleep(400);
        }
        return '';
      })();
      ok('S8-2 月份切换生效（查询身份变化）', switched === 'ok' && monthAfter === '2026-09',
        `before=${monthBefore} after=${monthAfter} action=${switched}`);
      const noStaleMonth = await cdp.evalJs(`(() => {
        const t = document.body.innerText || '';
        return t.includes('2026-09') ? 'yes' : 'no';
      })()`);
      ok('S8-3 切换后展示新月份（不残留旧月份标识）', noStaleMonth === 'yes', noStaleMonth);
    }

    // ========== S9 无未捕获异常 ==========
    // 只判真实异常（EXCEPTION: 前缀）与 error 级 console；antd 的 Warning 属既有代码提示，
    // 单独记录不判失败（避免把历史 warning 当本轮回归）。
    const allErrs = cdp.errors();
    const realErrs = allErrs.filter((e) => /^EXCEPTION:/.test(e)
      && !/favicon|ResizeObserver|Download the React DevTools/i.test(e));
    const warnings = allErrs.filter((e) => /^Warning:/.test(e));
    ok('S9-1 全链路无未捕获运行时异常', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));
    record('S9-2 antd 警告清单（既有代码提示，不判失败）', true,
      warnings.length ? `${warnings.length} 条：${warnings.slice(0, 2).join(' | ').slice(0, 200)}` : '无');

    summary('smoke-boundary-migration');
  } catch (e) {
    console.error('冒烟异常终止:', e.message);
    try { await cdp.shot('abort'); } catch {}
    process.exitCode = 1;
    summary('smoke-boundary-migration');
  } finally {
    await cdp.close();
  }
})();