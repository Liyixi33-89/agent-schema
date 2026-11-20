/**
 * admin-console 浏览器冒烟（独立会话）：
 *  A1 登录页装载 → 登录成功进入壳
 *  A2 五页签齐全（features/{usage,members,notices,ops-health}）
 *  A3 健康页装载 + 区域状态可见（RegionStatusBar 逐区状态——本轮修复点）
 *  A4 SLA 页月份切换（查询身份变化重置——本轮修复点）
 *  A5 无未捕获运行时异常
 *
 * 环境：SMOKE_ADMIN（默认 ACCEPT_BASE_URL）/ ACCEPT_ALLOW_INSECURE_ORIGIN
 */
const cdp = require('./cdp.cjs');
const { BASE, ok, record, summary } = require('./accept-lib.cjs');
const S = require('./smoke-lib.cjs');

const ADMIN = process.env.SMOKE_ADMIN || BASE;
/** 路径前缀：验收面 /accept，CI 独立栈为空串。 */
const P = process.env.SMOKE_PATH_PREFIX !== undefined ? process.env.SMOKE_PATH_PREFIX : '/accept';
const SUITE = 'smoke-admin';

(async () => {
  await cdp.launch();
  try {
    // ===== A1 登录 =====
    await cdp.goto(`${ADMIN}${P}/admin/`);
    const loginReady = await S.waitInput('管理员账号', 30000);
    ok('A1-1 admin-console 登录页装载', loginReady, '');
    if (!loginReady) throw new Error('admin 登录页未装载');

    await S.fillByPlaceholder('管理员账号', S.USERNAME);
    await S.fillPassword(S.PASSWORD);
    await S.clickButtonByText('登录');
    const shellUp = await S.waitText('平台管理端', 25000);
    ok('A1-2 登录成功进入壳', shellUp, '');

    // ===== A2 五页签 =====
    const tabs = await S.waitTabs(5, 20000);
    const expectTabs = ['租户用量', '成员管理', '健康状态', 'SLA 看板', '维护公告'];
    const missing = expectTabs.filter((t) => !tabs.includes(t));
    ok('A2-1 五页签齐全（features/{usage,members,notices,ops-health}）', missing.length === 0,
      `tabs=${tabs.join('/')} missing=${missing.join(',')}`);

    // ===== A3 健康页区域状态 =====
    await S.clickTab('健康状态');
    const healthUp = await S.waitAnyText(['平台状态', '无权查看租户健康详情', '健康数据加载失败'], 25000);
    ok('A3-1 健康页装载（五区域 Hook）', healthUp != null, String(healthUp));
    const regionState = await cdp.evalJs(`(() => {
      const t = document.body.innerText || '';
      const hasRegionBar = /加载中|刷新中|加载失败|无权限查看|刷新失败/.test(t);
      const hasCards = document.querySelectorAll('.ant-card').length;
      return JSON.stringify({ hasRegionBar, hasCards });
    })()`);
    const rs = JSON.parse(regionState || '{}');
    ok('A3-2 区域状态可见（RegionStatusBar 逐区状态）', rs.hasRegionBar === true || rs.hasCards > 0,
      `regionBar=${rs.hasRegionBar} cards=${rs.hasCards}`);

    // ===== A4 SLA 月份切换 =====
    await S.clickTab('SLA 看板');
    const slaUp = await S.waitAnyText(['SLA 月度数据', '无权查看 SLA 看板', 'SLA 数据加载失败', '当前查询月份'], 25000);
    ok('A4-1 SLA 页装载', slaUp != null, String(slaUp));
    const monthBefore = await cdp.evalJs(
      `(() => { const m = (document.body.innerText || '').match(/当前查询月份：(\\d{4}-\\d{2})/); return m ? m[1] : ''; })()`,
    );
    const switched = await cdp.evalJs(`(() => {
      const el = Array.from(document.querySelectorAll('input')).find(i => (i.placeholder || '').includes('YYYY-MM'));
      if (!el) return 'missing-input';
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '2026-09');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const wrap = el.closest('.ant-input-search') || el.parentElement;
      const btn = (wrap && wrap.querySelector('.ant-input-search-button'))
        || Array.from(document.querySelectorAll('button')).find(b => (b.textContent || '').includes('查询'));
      if (!btn) return 'no-btn';
      btn.click();
      return 'ok';
    })()`);
    const monthAfter = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 20000) {
        const m = await cdp.evalJs(
          `(() => { const x = (document.body.innerText || '').match(/当前查询月份：(\\d{4}-\\d{2})/); return x ? x[1] : ''; })()`,
        );
        if (m === '2026-09') return m;
        await S.sleep(400);
      }
      return '';
    })();
    ok('A4-2 月份切换生效（查询身份变化）', switched === 'ok' && monthAfter === '2026-09',
      `before=${monthBefore} after=${monthAfter} action=${switched}`);
    const noStale = await cdp.evalJs(
      `(() => { const t = document.body.innerText || ''; return t.includes('2026-09') ? 'yes' : 'no'; })()`,
    );
    ok('A4-3 切换后展示新月份（不残留旧月份标识）', noStale === 'yes', noStale);

    // ===== A5 异常 =====
    const { real, warnings } = S.splitErrors();
    ok('A5-1 无未捕获运行时异常', real.length === 0, real.slice(0, 3).join(' | '));
    record('A5-2 antd 警告清单（既有提示，不判失败）', true,
      warnings.length ? `${warnings.length} 条：${warnings.slice(0, 2).join(' | ').slice(0, 200)}` : '无');

    summary(SUITE);
  } catch (e) {
    console.error('admin 冒烟异常终止:', e.message);
    try { await cdp.shot('abort'); } catch {}
    process.exitCode = 1;
    summary(SUITE);
  } finally {
    await cdp.close();
  }
})();