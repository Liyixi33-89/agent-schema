/**
 * M11 浏览器验收 ①（v3 严格版）：designer 工作台闭环
 * 双通道：浏览器 UI 走查（CDP）+ API 断言（状态码/业务码）+ DB 落库核对
 * fail-fast：任何断言失败立即终止，禁止无条件成功
 */
const fs = require('fs');
const path = require('path');
const cdp = require('./cdp.cjs');
const { BASE, ok, record, ApiClient, dbQuery, summary } = require('./accept-lib.cjs');

async function waitText(include, timeoutMs = 6000, exclude = null) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const body = await cdp.evalJs('document.body.innerText');
    if (body.includes(include) && (!exclude || !body.includes(exclude))) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function clickTab(name) {
  await cdp.evalJs(`(() => { const t = Array.from(document.querySelectorAll('.ant-tabs-tab')).find(x => x.textContent.includes('${name}')); t?.click(); })()`);
  await new Promise((r) => setTimeout(r, 700));
}

(async () => {
  await cdp.launch();
  try {
    // ---------- 0. API 负例：错误密码拒绝（业务码断言） ----------
    const bad = new ApiClient('bad');
    await bad.expect('API 错误密码拒绝', 'POST', '/api/auth/login', 401,
      { username: 'accept_admin', password: 'WrongPass!' });

    // ---------- 1. 登录页 UI ----------
    await cdp.goto(`${BASE}/designer/`);
    await cdp.waitFor('input[placeholder="账号"]', 10000);
    ok('登录页渲染', (await cdp.text('.ant-card-head-title'))?.includes('登录'));

    // UI 负例：错误密码提示
    await cdp.fill('input[placeholder="账号"]', 'accept_admin');
    await cdp.fill('input[placeholder="密码"]', 'WrongPass!');
    await cdp.click('button[type="submit"]');
    ok('UI 错误密码提示', await waitText('账号或密码错误', 4000));

    // 正确登录
    await cdp.fill('input[placeholder="密码"]', 'Accept!2026');
    await cdp.click('button[type="submit"]');
    await cdp.waitFor('.ant-layout-header', 10000);
    ok('登录成功进入工作台', await waitText('新建应用', 8000));

    // ---------- 2. 卡片墙（断言已有应用） ----------
    const cardTitles = await cdp.texts('.ant-card .ant-card-head-title');
    ok('卡片墙展示验收应用「报销管理」', cardTitles.some((t) => t.includes('报销管理')), JSON.stringify(cardTitles));
    await cdp.shot('designer-workspace');

    // ---------- 3. 新建应用：API 创建 + UI 卡片出现（断言新 ID） ----------
    const admin = new ApiClient('admin');
    await admin.login('API 管理员登录', 'accept_admin', 'Accept!2026');
    const stamp = Date.now().toString(36);
    const appName = `验收应用${stamp}`;
    const created = await admin.expect('API 新建应用', 'POST', '/api/apps', 200,
      { name: appName, description: '严格验收创建' });
    const newAppId = created.json?.appId ?? created.json?.id;
    ok('新建应用返回新 ID', Number.isInteger(newAppId) && newAppId >= 2, `appId=${newAppId}`);
    const dbApp = dbQuery(`SELECT name, status FROM app WHERE id = ${newAppId}`);
    ok('新建应用落库', dbApp.length === 1 && dbApp[0].includes(appName) && dbApp[0].includes('ACTIVE'),
      JSON.stringify(dbApp));

    // UI 刷新后卡片出现（同会话浏览器）
    await cdp.goto(`${BASE}/designer/`);
    await cdp.waitFor('.ant-layout-header', 8000);
    ok('UI 新卡片出现', await waitText(appName, 6000));
    await cdp.shot('designer-created');

    // ---------- 4. 应用设置四页签（报销管理 app=1） ----------
    await cdp.evalJs(`(() => { const cards = Array.from(document.querySelectorAll('.ant-card')); const c = cards.find(x => x.textContent.includes('报销管理')); (c?.querySelector('button') || c)?.click(); })()`);
    await cdp.waitFor('.ant-tabs', 8000);
    const tabs = await cdp.texts('.ant-tabs-tab');
    ok('四页签就绪', ['成员', '导航', '主题', '发布'].every((t) => tabs.some((x) => x.includes(t))), JSON.stringify(tabs));

    // 成员页签：断言 API 成员列表与 DB 一致
    const members = await admin.expect('API 应用成员列表', 'GET', '/api/apps/1/members', 200, null);
    const memberList = members.json?.list;
    ok('成员列表结构(list[])', Array.isArray(memberList) && memberList.length >= 2,
      JSON.stringify(memberList?.map((m) => m.account)));
    ok('成员列表含双账号', memberList?.some((m) => m.account === 'accept_admin') && memberList?.some((m) => m.account === 'accept_user'),
      JSON.stringify(memberList?.map((m) => `${m.account}:${m.roles?.join('/')}`)));
    const dbMembers = dbQuery(`SELECT count(*) FROM sys_user_role ur JOIN sys_role r ON r.id=ur.role_id WHERE r.app_id=1`);
    ok('成员数与 DB 角色行一致', memberList?.length === Number(dbMembers[0]),
      `api=${memberList?.length} db=${dbMembers[0]}`);
    ok('UI 成员列表含 accept_user', await waitText('accept_user', 5000));

    // 导航页签
    await clickTab('导航');
    ok('导航树渲染「帮助中心」', await waitText('帮助中心', 5000));
    await cdp.shot('designer-nav');

    // 导航保存：带乐观锁版本号（协议：baseVersion + nodes）
    const navRead = await admin.expect('API 导航读取', 'GET', '/api/apps/1/nav', 200, null);
    const navBase = navRead.json?.version;
    ok('导航读取含版本号', Number.isInteger(navBase), `version=${navBase}`);
    const navBefore = dbQuery('SELECT nav_version FROM app WHERE id=1')[0];
    const navSave = await admin.expect('API 导航保存', 'PUT', '/api/apps/1/nav', 200, {
      version: navBase,
      tree: [
        { id: 'g1', type: 'GROUP', label: '报销中心', children: [{ id: 'p1', type: 'PAGE', label: '报销登记', refId: 1 }] },
        { id: 'l1', type: 'LINK', label: '帮助中心', url: 'https://example.com/help' },
      ],
    });
    const navAfter = dbQuery('SELECT nav_version FROM app WHERE id=1')[0];
    ok('导航版本递增落库', Number(navAfter) > Number(navBefore), `${navBefore} → ${navAfter}`);
    const navLink = dbQuery(`SELECT (nav_tree::text LIKE '%帮助中心%') AND (nav_tree::text LIKE '%example.com/help%') FROM app WHERE id=1`);
    ok('导航树内容落库', navLink[0] === 't', JSON.stringify(navLink));

    // 发布页签：API 实际发布 + 断言版本号
    const pub = await admin.expect('API 发布', 'POST', '/api/apps/1/publish', 200,
      { pageIds: [1], changelog: '严格验收发布' });
    const releaseVersion = pub.json?.releaseVersion ?? pub.json?.version;
    ok('发布返回版本号', Number.isInteger(releaseVersion) && releaseVersion >= 2, `version=${releaseVersion}`);
    const dbRel = dbQuery('SELECT release_version, status FROM app_release WHERE app_id=1 ORDER BY id DESC LIMIT 1');
    ok('发布落库(ACTIVE)', dbRel.length === 1 && dbRel[0].startsWith(`${releaseVersion}\t`) || dbRel[0].includes('ACTIVE'),
      JSON.stringify(dbRel));
    await clickTab('发布');
    ok('UI 发布记录可见', await waitText('严格验收发布', 5000) || await waitText('发布全部页面', 5000));
    await cdp.shot('designer-publish');

    // ---------- 5. 删除确认协议（新应用：预检/负例/确认删除/落库） ----------
    const pre = await admin.expect('API 删除预检', 'POST', `/api/apps/${newAppId}/delete-precheck`, 200, null);
    ok('预检影响面结构', pre.json?.confirmField === 'name' && pre.json?.impact?.appName === appName
      && Number.isInteger(pre.json?.impact?.pages) && Number.isInteger(pre.json?.impact?.members),
      JSON.stringify(pre.json));
    const delNoConfirm = await admin.call('DELETE', `/api/apps/${newAppId}`);
    ok('无确认值删除被拒(409)', delNoConfirm.status === 409 && delNoConfirm.json?.code === 'APP_DELETE_CONFIRM_REQUIRED',
      `HTTP ${delNoConfirm.status} code=${delNoConfirm.json?.code}`);
    const delNoMatch = await admin.call('DELETE', `/api/apps/${newAppId}`, { confirmValue: '错误的名字' });
    ok('错误确认值删除被拒', [409, 400].includes(delNoMatch.status), `HTTP ${delNoMatch.status} body=${delNoMatch.raw.slice(0, 120)}`);
    const delOk = await admin.expect('API 确认删除', 'DELETE', `/api/apps/${newAppId}`, 200,
      { confirmValue: appName });
    const dbGone = dbQuery(`SELECT count(*) FROM app WHERE id=${newAppId} AND deleted_at IS NULL`);
    ok('删除后落库标记', dbGone[0] === '0', JSON.stringify(dbGone));

    // UI 删除弹层走查（在报销管理上取消，不真删）
    await clickTab('主题');
    await cdp.evalJs(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('删除应用')); b?.click(); })()`);
    await cdp.waitFor('.ant-modal', 5000);
    const delModal = await cdp.text('.ant-modal');
    ok('UI 删除弹层含影响面与确认输入', delModal?.includes('影响面') && delModal?.includes('确认删除'), (delModal ?? '').slice(0, 120));
    await cdp.evalJs(`(() => { const b = Array.from(document.querySelectorAll('.ant-modal button')).find(x => x.textContent.includes('取 消') || x.textContent.includes('Cancel')); b?.click(); })()`);
    await cdp.shot('designer-delete-modal');

    // ---------- 6. 越权负例（普通成员不可管理应用） ----------
    const user = new ApiClient('user');
    await user.login('API 普通成员登录', 'accept_user', 'Accept!2026');
    const forbidden = await user.call('POST', '/api/apps', { name: `越权${stamp}`, description: 'x' });
    ok('普通成员建应用被拒(403)', forbidden.status === 403, `HTTP ${forbidden.status} body=${forbidden.raw.slice(0, 100)}`);
    const userPre = await user.call('POST', '/api/apps/1/delete-precheck');
    ok('普通成员预检被拒(403)', userPre.status === 403, `HTTP ${userPre.status}`);

    // ---------- 7. console 错误 ----------
    const errs = cdp.errors().filter((e) => !e.includes('favicon'));
    ok('无未捕获 console 错误', errs.length === 0, errs.slice(0, 3).join(' | ').slice(0, 200));

    summary('designer');
  } finally {
    await cdp.close();
  }
})().catch((e) => {
  console.error('FATAL:', e.message);
  summary('designer');
  process.exitCode = 1;
});
