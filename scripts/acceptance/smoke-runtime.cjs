/**
 * runtime 浏览器冒烟（独立会话）：
 *  R1 应用列表可读（API 通道，为导航壳提供目标应用）
 *  R2 导航壳装载（app/AppShell）
 *  R3 导航装载完成（非卡在加载态）
 *  R4 页面装载（features/page-host/FormPageHost）
 *  R5 无未捕获运行时异常
 *
 * 环境：SMOKE_RUNTIME（默认 ACCEPT_BASE_URL）/ ACCEPT_API_PREFIX / ACCEPT_ALLOW_INSECURE_ORIGIN
 */
const cdp = require('./cdp.cjs');
const { BASE, ok, record, ApiClient, summary } = require('./accept-lib.cjs');
const S = require('./smoke-lib.cjs');

const RUNTIME = process.env.SMOKE_RUNTIME || BASE;
const SUITE = 'smoke-runtime';

(async () => {
  await cdp.launch();
  try {
    // ===== R1 应用列表（API 通道）=====
    const admin = new ApiClient('admin');
    await admin.login('API 管理员登录', S.USERNAME, S.PASSWORD);
    const apps = await admin.call('GET', '/api/apps?keyword=');
    const appList = (apps.json && apps.json.list) || [];
    ok('R1-1 应用列表可读（API 通道）', apps.status === 200 && appList.length > 0, `count=${appList.length}`);
    if (appList.length === 0) throw new Error('无可用应用——无法验证导航壳');
    const targetApp = appList[0];

    // ===== R2 导航壳 =====
    await cdp.goto(`${RUNTIME}/accept/runtime/#/app/${targetApp.id}`);
    const shellText = await S.waitAnyText(['加载导航', '无可访问菜单', '从左侧菜单选择页面'], 25000);
    ok('R2-1 导航壳装载（app/AppShell）', shellText != null, String(shellText));

    // ===== R3 导航装载完成 =====
    // 装载完成判据：出现「无可访问菜单」/「从左侧菜单选择页面」/ 菜单项，
    // 或「加载导航」消失。注意：无菜单应用会一直显示「无可访问菜单」——那是完成态而非加载态。
    const navLoaded = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 20000) {
        const t = await S.bodyText();
        const done = t.includes('无可访问菜单')
          || t.includes('从左侧菜单选择页面')
          || (t.length > 10 && !t.includes('加载导航'));
        if (done) return true;
        await S.sleep(400);
      }
      return false;
    })();
    ok('R3-1 导航装载完成（非卡在加载态）', navLoaded, '');

    // ===== R4 页面装载 =====
    const pages = await admin.call('GET', `/api/pages?appId=${targetApp.id}`);
    const pageList = (pages.json && pages.json.list) || [];
    if (pageList.length > 0) {
      const pid = pageList[0].id;
      await cdp.goto(`${RUNTIME}/accept/runtime/#/app/${targetApp.id}/page/${pid}`);
      const pageUp = await (async () => {
        const start = Date.now();
        while (Date.now() - start < 25000) {
          const t = await S.bodyText();
          if (t.length > 20 && !t.includes('加载导航')) return t.slice(0, 80);
          await S.sleep(400);
        }
        return null;
      })();
      ok('R4-1 页面装载（features/page-host/FormPageHost）', pageUp != null, String(pageUp));
    } else {
      record('R4-1 页面装载', true, '该应用无页面——跳过页面渲染断言（导航壳已验）');
    }

    // ===== R5 异常 =====
    const { real, warnings } = S.splitErrors();
    ok('R5-1 无未捕获运行时异常', real.length === 0, real.slice(0, 3).join(' | '));
    record('R5-2 antd 警告清单（既有提示，不判失败）', true,
      warnings.length ? `${warnings.length} 条：${warnings.slice(0, 2).join(' | ').slice(0, 200)}` : '无');

    summary(SUITE);
  } catch (e) {
    console.error('runtime 冒烟异常终止:', e.message);
    try { await cdp.shot('abort'); } catch {}
    process.exitCode = 1;
    summary(SUITE);
  } finally {
    await cdp.close();
  }
})();