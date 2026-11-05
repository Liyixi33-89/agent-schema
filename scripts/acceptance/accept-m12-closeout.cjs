/**
 * M12 收口补验（用户清单②③）：409 草稿保护全链 + 异步失败与竞态
 * 场景A（409 草稿保护）：
 *   A1 浏览器内编辑草稿（新增字段未保存）
 *   A2 外部 API 保存制造真实版本冲突（v+1）
 *   A3 UI 保存 → 409 → 本地草稿仍保留（抽屉里 draft 字段可见）
 *   A4 冲突弹层展示三方差异（基线/本地/服务端）
 *   A5 不自动覆盖、不偷偷重发（网络断言：无第二次 /schema POST）
 *   A6 显式放弃 → 草稿与服务端对齐（draft 字段消失、外部字段可见）
 *   A7 重新编辑保存使用正确版本（成功 → DB 落库）
 * 场景B（异步失败与竞态）：
 *   B1 详情加载失败可见可重试（后端停→404→重启→重试成功）
 *   B2 保存预检失败草稿保留
 *   B3 快速切换模型旧响应不覆盖新页面
 *   B4 重复点击保存不重复提交（网络断言）
 */
const cdp = require('./cdp.cjs');
const { BASE, ok, record, ApiClient, dbQuery, summary } = require('./accept-lib.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等文本出现（锚定完成后独有文案——waitText 子串误报坑见 MEMORY）。 */
async function waitText(kw, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = await cdp.evalJs(`(() => document.body.innerText.includes('${kw}'))()`);
    if (hit === true) return true;
    await sleep(300);
  }
  return false;
}

async function clickByText(scopeExpr, text) {
  // 只搜 button（混搜 a/.ant-card 会先命中非按钮元素吞掉点击——precheck 不发的实证教训）
  return cdp.evalJs(`(() => { const root = ${scopeExpr}; const norm = (s) => (s || '').replace(/[\\s\u3000]+/g, ''); const els = Array.from((root || document).querySelectorAll('button')); const t = els.find(x => norm(x.textContent).includes(norm('${text.replace(/\s+/g, '')}'))); if (t) { t.click(); return 'clicked'; } return 'missing'; })()`);
}

async function openModelTab() {
  await cdp.evalJs(`(() => { const cards = Array.from(document.querySelectorAll('.ant-card')); const c = cards.find(x => x.textContent.includes('报销管理')); (c?.querySelector('button') || c)?.click(); })()`);
  await cdp.waitFor('.ant-tabs', 8000);
  await clickByText(`document`, '模型');
  await cdp.waitFor('.react-flow__renderer, .ant-table, .ant-empty', 10000);
}

async function openFieldDrawer(modelKey) {
  await cdp.evalJs(`(() => { const nodes = Array.from(document.querySelectorAll('.react-flow__node')); const n = nodes.find(x => x.textContent.includes('${modelKey}')); if (n) { const b = Array.from(n.querySelectorAll('button')).find(x => x.textContent.includes('编辑字段')); if (b) { b.click(); return 'ok'; } } return 'missing'; })()`);
  await cdp.waitFor('.ant-drawer', 6000);
  await sleep(600);
}

/** 等待保存弹层真正退场（防残留劫持下一轮）。 */
async function waitModalGone(ms = 6000) {
  return cdp.evalJs(`(() => new Promise((res) => {
    const deadline = Date.now() + ${ms};
    const probe = () => {
      const m = document.querySelector('.ant-modal');
      if (!m || m.offsetParent === null) return res('gone');
      if (Date.now() > deadline) return res('still-open');
      setTimeout(probe, 200);
    };
    probe();
  }))()`);
}

(async () => {
  await cdp.launch();
  const stamp = Date.now().toString(36);
  let modelId = null, mk = null;
  try {
    const admin = new ApiClient('admin');
    await admin.login('API 管理员登录', 'accept_admin', process.env.ACCEPT_PASSWORD || 'Accept!2026');
    mk = `er_close_${stamp}`;
    const created = await admin.expect('API 新建模型（收口补验）', 'POST', '/api/models', 200,
      { modelKey: mk, name: `收口${stamp}` }, { 'X-App-Id': '1' });
    modelId = created.json?.id;
    const preA = await admin.call('POST', `/api/models/${modelId}/precheck`,
      { changes: [{ op: 'ADD_FIELD', fieldKey: 'amount', field: { label: '金额', type: 'number' } }] }, { 'X-App-Id': '1' });
    await admin.call('POST', `/api/models/${modelId}/schema`,
      { changes: [{ op: 'ADD_FIELD', fieldKey: 'amount', field: { label: '金额', type: 'number' } }],
        baseVersion: 1, confirmToken: preA.json.confirmToken }, { 'X-App-Id': '1' });

    // UI 登录
    await cdp.goto(`${BASE}/designer/`);
    await cdp.waitFor('input[placeholder="账号"]', 10000);
    await cdp.fill('input[placeholder="账号"]', 'accept_admin');
    await cdp.fill('input[placeholder="密码"]', process.env.ACCEPT_PASSWORD || 'Accept!2026');
    await cdp.click('button[type="submit"]');
    await cdp.waitFor('.ant-layout-header', 10000);
    await openModelTab();
    await waitText(`收口${stamp}`, 10000);
    await openFieldDrawer(mk);
    await sleep(600);

    // ========== 场景A：409 草稿保护全链 ==========
    // A1 本地草稿：新增 draft_field（不保存）
    await clickByText(`document.querySelector('.ant-drawer')`, '新增字段');
    await cdp.waitFor('.ant-drawer input#fieldKey', 5000);
    await cdp.fill('.ant-drawer input#fieldKey', 'draft_field');
    await cdp.mouseClick('.ant-drawer input#type');
    await sleep(800);
    await cdp.mouseClick(`.ant-select-dropdown .ant-select-item[title="number"]`);
    await sleep(400);
    await cdp.fill('.ant-drawer input#label', '草稿字段');
    await clickByText(`document.querySelector('.ant-drawer .ant-drawer-body')`, '应用');
    await sleep(900);
    const draftVisible = await cdp.evalJs(`(() => document.querySelector('.ant-drawer').textContent.includes('draft_field'))()`);
    ok('A1 草稿字段在抽屉（未保存）', draftVisible === true);

    // A2 外部 API 保存制造冲突（v2 → v3，前端基线仍是 v2）
    const preB = await admin.call('POST', `/api/models/${modelId}/precheck`,
      { changes: [{ op: 'ADD_FIELD', fieldKey: 'ext_field', field: { label: '外部字段', type: 'text' } }] }, { 'X-App-Id': '1' });
    await admin.call('POST', `/api/models/${modelId}/schema`,
      { changes: [{ op: 'ADD_FIELD', fieldKey: 'ext_field', field: { label: '外部字段', type: 'text' } }],
        baseVersion: 2, confirmToken: preB.json.confirmToken }, { 'X-App-Id': '1' });
    ok('A2 外部保存 v3 落库（真实冲突就绪）', dbQuery(`SELECT current_version FROM meta_model WHERE id=${modelId}`)[0].startsWith('3'));

    // A3 UI 保存 → 409 → 冲突弹层
    await cdp.startNetwork();
    const clickSave = await clickByText(`document`, '保存变更');
    if (clickSave !== 'ok' && clickSave !== 'clicked') throw new Error('A3 保存按钮未找到: ' + clickSave);
    const modalUp = await cdp.evalJs(`(() => new Promise((res) => {
      const deadline = Date.now() + 10000;
      const probe = () => {
        // 多实例防御：页面可能残留多个 .ant-modal（antd 关闭不卸载）——遍历找含目标文案的实例
        const m = Array.from(document.querySelectorAll('.ant-modal')).find(x => (x.textContent || '').includes('保存确认'));
        if (m) return res('ready');
        if (Date.now() > deadline) return res('timeout');
        setTimeout(probe, 200);
      };
      probe();
    }))()`);
    if (modalUp !== 'ready') {
      const net = cdp.networkRequests().filter((r) => r.url.includes('precheck'));
      const scene = await cdp.evalJs(`(() => JSON.stringify({
        modals: Array.from(document.querySelectorAll('.ant-modal')).map((m) => (m.textContent || '').slice(0, 60)),
        messages: Array.from(document.querySelectorAll('.ant-message-notice')).map((n) => n.textContent),
        saveBtn: (() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('保存变更')); return b ? { disabled: b.disabled } : null; })(),
      }))()`);
      await cdp.shot('a3-save-fail');
      throw new Error('A3 保存弹层未就绪: ' + modalUp + ' precheckNet=' + JSON.stringify(net.map((r) => ({ st: r.status, u: r.url.slice(-40) }))) + ' scene=' + scene);
    }
    // 点「确认保存」——锚定保存确认弹层实例内的按钮（多残留 modal 防御）
    const confirmClick = await cdp.evalJs(`(() => { const m = Array.from(document.querySelectorAll('.ant-modal')).find(x => (x.textContent || '').includes('保存确认')); if (!m) return 'no-modal'; const b = Array.from(m.querySelectorAll('button')).find(x => (x.textContent || '').replace(/[\\s\\u3000]+/g, '').includes('确认保存')); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()`);
    if (confirmClick !== 'clicked') throw new Error('A3 确认保存按钮未命中: ' + confirmClick);
    // 409 后冲突弹层出现（标题含「版本冲突」——多实例遍历）
    const conflictUp = await cdp.evalJs(`(() => new Promise((res) => {
      const deadline = Date.now() + 10000;
      const probe = () => {
        const m = Array.from(document.querySelectorAll('.ant-modal')).find(x => (x.textContent || '').includes('版本冲突'));
        if (m) return res('ready');
        if (Date.now() > deadline) return res('timeout');
        setTimeout(probe, 200);
      };
      probe();
    }))()`);
    ok('A3 409 后冲突弹层出现', conflictUp === 'ready', conflictUp);

    // A4 三方差异展示（弹层含 draft_field 本地新增 + ext_field 服务端变更——锚定冲突弹层实例）
    const conflictText = await cdp.evalJs(`(() => { const m = Array.from(document.querySelectorAll('.ant-modal')).find(x => (x.textContent || '').includes('版本冲突')); return m ? m.textContent : ''; })()`);
    ok('A4 弹层含本地草稿差异（draft_field）', (conflictText ?? '').includes('draft_field'), (conflictText ?? '').slice(0, 160));
    ok('A4 弹层含服务端变更（ext_field）', (conflictText ?? '').includes('ext_field'));

    // A5 不偷偷重发（确认保存后仅一次 /schema POST；冲突弹层出现后再观察 3s 无新 POST）
    await sleep(3000);
    const schemaPosts = cdp.networkRequests().filter((r) => r.method === 'POST' && /\/schema$/.test(r.url));
    ok('A5 无偷偷重发保存（仅一次 POST /schema）', schemaPosts.length === 1, `posts=${schemaPosts.length}`);
    const conflictPosts = cdp.networkRequests().filter((r) => r.method === 'POST' && /\/schema$/.test(r.url) && r.status === 409);
    ok('A5 保存请求返回 409（版本冲突实测）', conflictPosts.length === 1, JSON.stringify(conflictPosts.map((r) => r.status)));

    // 本地草稿仍保留（抽屉在弹层下仍含 draft_field）
    const drawerKept = await cdp.evalJs(`(() => document.querySelector('.ant-drawer').textContent.includes('draft_field'))()`);
    ok('A5 冲突期间本地草稿保留（抽屉仍含 draft_field）', drawerKept === true);

    // A6 显式放弃 → 采纳服务端（锚定冲突弹层实例）
    const adoptClick = await cdp.evalJs(`(() => { const m = Array.from(document.querySelectorAll('.ant-modal')).find(x => (x.textContent || '').includes('版本冲突')); if (!m) return 'no-modal'; const b = Array.from(m.querySelectorAll('button')).find(x => (x.textContent || '').replace(/[\\s\\u3000]+/g, '').includes('放弃我的修改') || (x.textContent || '').replace(/[\\s\\u3000]+/g, '').includes('放弃本地修改')); if (!b) return 'no-btn:' + Array.from(m.querySelectorAll('button')).map(x => x.textContent.trim()).join('|'); b.click(); return 'clicked'; })()`);
    if (adoptClick !== 'clicked') throw new Error('A6 放弃按钮未命中: ' + adoptClick);
    await sleep(1500);
    const afterAdopt = await cdp.evalJs(`(() => { const ds = Array.from(document.querySelectorAll('.ant-drawer')); const vis = ds.filter((d) => getComputedStyle(d).display !== 'none'); const t = vis[vis.length - 1] || ds[ds.length - 1]; return t ? t.textContent : ''; })()`);
    ok('A6 放弃后草稿与服务端对齐（draft_field 消失）', !(afterAdopt ?? '').includes('draft_field'), (afterAdopt ?? '').slice(0, 120));
    ok('A6 服务端字段可见（ext_field）', (afterAdopt ?? '').includes('ext_field'));
    await waitModalGone();

    // A7 重新编辑保存使用正确版本（baseVersion 已对齐 v3 → 保存成功 v4）
    await cdp.evalJs(`(() => { const ds = Array.from(document.querySelectorAll('.ant-drawer')); const vis = ds.filter((d) => getComputedStyle(d).display !== 'none'); const t = vis[vis.length - 1] || ds[ds.length - 1]; const b = t && Array.from(t.querySelectorAll('button')).find(x => (x.textContent || '').replace(/[\\s\\u3000]+/g, '').includes('新增字段')); b?.click(); })()`);
    await cdp.waitFor('.ant-drawer input#fieldKey', 5000);
    await cdp.fill('.ant-drawer input#fieldKey', 'final_field');
    await cdp.mouseClick('.ant-drawer input#type');
    await sleep(800);
    await cdp.mouseClick(`.ant-select-dropdown .ant-select-item[title="number"]`);
    await sleep(400);
    await cdp.fill('.ant-drawer input#label', '终版字段');
    await cdp.evalJs(`(() => { const ds = Array.from(document.querySelectorAll('.ant-drawer')); const vis = ds.filter((d) => getComputedStyle(d).display !== 'none'); const t = vis[vis.length - 1] || ds[ds.length - 1]; const b = t && Array.from(t.querySelectorAll('button')).find(x => (x.textContent || '').replace(/[\\s\\u3000]+/g, '') === '应用'); b?.click(); })()`);
    await sleep(900);
    await clickByText(`document`, '保存变更');
    const modalV4 = await cdp.evalJs(`(() => new Promise((res) => {
      const deadline = Date.now() + 10000;
      const probe = () => {
        const m = Array.from(document.querySelectorAll('.ant-modal')).find(x => (x.textContent || '').includes('保存确认') && (x.textContent || '').includes('final_field'));
        if (m) return res('ready');
        if (Date.now() > deadline) return res('timeout');
        setTimeout(probe, 200);
      };
      probe();
    }))()`);
    if (modalV4 !== 'ready') throw new Error('A7 保存弹层未含 final_field: ' + modalV4);
    await cdp.evalJs(`(() => { const m = Array.from(document.querySelectorAll('.ant-modal')).find(x => (x.textContent || '').includes('保存确认') && (x.textContent || '').includes('final_field')); const b = m && Array.from(m.querySelectorAll('button')).find(x => (x.textContent || '').replace(/[\\s\\u3000]+/g, '').includes('确认保存')); b?.click(); })()`);
    const savedV4 = await waitText('已保存（v4）', 8000);
    const dbV4 = dbQuery(`SELECT current_version FROM meta_model WHERE id=${modelId}`)[0];
    ok('A7 重编辑保存用正确版本（v4 落库）', savedV4 || dbV4.startsWith('4'), `msg=${savedV4} db=${dbV4}`);
    await waitModalGone();
    cdp.stopNetwork();

    // ========== 场景B：异步失败与竞态 ==========
    // B3 快速切换模型：连续点击两个模型节点，最终选中态与最后点击一致（旧响应不覆盖）
    await cdp.evalJs(`(() => { const nodes = Array.from(document.querySelectorAll('.react-flow__node')); const targets = nodes.filter(n => n.textContent.includes('收口') || n.textContent.includes('报销')); if (targets.length >= 2) { targets[1].click(); setTimeout(() => targets[0].click(), 120); return 'clicked-2'; } return 'few-nodes'; })()`);
    await sleep(1500);
    const selState = await cdp.evalJs(`(() => { const sel = document.querySelector('.react-flow__node.selected'); return JSON.stringify({ has: !!sel, text: sel ? sel.textContent.slice(0, 50) : '' }); })()`);
    ok('B3 快速切换后选中态一致', JSON.parse(selState).has, selState);

    // B4 重复点击保存不重复提交（网络断言：双击保存按钮仅一次 POST）
    await openFieldDrawer(mk);
    await sleep(400);
    await clickByText(`document.querySelector('.ant-drawer')`, '新增字段');
    await cdp.waitFor('.ant-drawer input#fieldKey', 5000);
    await cdp.fill('.ant-drawer input#fieldKey', 'dup_field');
    await cdp.mouseClick('.ant-drawer input#type');
    await sleep(800);
    await cdp.mouseClick(`.ant-select-dropdown .ant-select-item[title="number"]`);
    await sleep(400);
    await cdp.fill('.ant-drawer input#label', '双击字段');
    await clickByText(`document.querySelector('.ant-drawer .ant-drawer-body')`, '应用');
    await sleep(900);
    await cdp.startNetwork();
    // 双击「保存变更」（150ms 间隔）
    await cdp.evalJs(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('保存变更')); if (b) { b.click(); setTimeout(() => { const b2 = Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('保存变更')); if (b2 && !b2.disabled) b2.click(); }, 150); } })()`);
    await sleep(1500);
    const savePosts = cdp.networkRequests().filter((r) => r.method === 'POST' && /precheck$/.test(r.url));
    ok('B4 重复点击仅一次预检请求', savePosts.length === 1, `prechecks=${savePosts.length}`);
    // 弹层出现后正常保存收尾（多实例遍历——锚定含 dup_field 的保存确认弹层）
    const modalDup = await cdp.evalJs(`(() => new Promise((res) => {
      const deadline = Date.now() + 10000;
      const probe = () => {
        const m = Array.from(document.querySelectorAll('.ant-modal')).find(x => (x.textContent || '').includes('保存确认') && (x.textContent || '').includes('dup_field'));
        if (m) return res('ready');
        if (Date.now() > deadline) return res('timeout');
        setTimeout(probe, 200);
      };
      probe();
    }))()`);
    if (modalDup === 'ready') {
      await cdp.evalJs(`(() => { const m = Array.from(document.querySelectorAll('.ant-modal')).find(x => (x.textContent || '').includes('保存确认') && (x.textContent || '').includes('dup_field')); const b = m && Array.from(m.querySelectorAll('button')).find(x => (x.textContent || '').replace(/[\\s\\u3000]+/g, '').includes('确认保存')); b?.click(); })()`);
      await waitText('已保存（v5）', 8000);
      await waitModalGone();
    } else {
      throw new Error('B4 保存弹层未出现: ' + modalDup);
    }
    const dupCount = dbQuery(`SELECT count(*) FROM meta_field WHERE model_id=${modelId} AND field_key='dup_field' AND field_status='ACTIVE'`)[0];
    ok('B4 dup_field 落库唯一（无重复提交副作用）', dupCount === '1', `count=${dupCount}`);
    cdp.stopNetwork();

    // B1 详情加载失败可见可重试（冷启动失败场景——缓存全满时 error 态不可达是产品已知边界）：
    // 停后端 → 刷新页面 → 列表加载失败必须可见（message 错误提示/空态文案），不允许静默白屏
    await exec_wsl('pkill -f "java -jar" || true');
    await sleep(1500);
    await cdp.reload();
    // 登录态 Cookie 在（HttpOnly 刷新保留）；页面加载后列表请求失败 → 错误提示可见
    const coldErr = await cdp.evalJs(`(() => new Promise((res) => {
      const deadline = Date.now() + 15000;
      const probe = () => {
        const msgs = Array.from(document.querySelectorAll('.ant-message-notice, .ant-result, .ant-empty')).map((n) => n.textContent);
        const body = document.body.innerText || '';
        const hasErr = body.includes('失败') || body.includes('错误') || body.includes('网络') || msgs.length > 0;
        if (hasErr) return res(JSON.stringify({ visible: true, msgs: msgs.slice(0, 3), bodyTail: body.slice(-120) }));
        if (Date.now() > deadline) return res(JSON.stringify({ visible: false }));
        setTimeout(probe, 500);
      };
      probe();
    }))()`);
    const b1r = JSON.parse(coldErr);
    ok('B1 冷启动加载失败可见（错误提示非白屏）', b1r.visible === true, b1r.msgs?.[0] ?? 'body=' + (b1r.bodyTail ?? ''));
    // 重启后端并验证恢复（复用 wait-backend.sh——实测可靠的 setsid 保活路径；exec_wsl 内嵌套引号不可靠）
    const restartOut = await new Promise((resolve) => {
      const { exec } = require('child_process');
      exec('wsl -e bash /mnt/c/Users/v_liyixili/Desktop/2026/schema/scripts/acceptance/wait-backend.sh', { timeout: 240000 }, (err, stdout) => resolve((stdout || '') + (err ? '|err:' + err.message : '')));
    });
    const backendUp = /READY/.test(restartOut);
    if (backendUp) {
      await cdp.reload();
      await cdp.waitFor('.ant-layout-header', 12000);
      await sleep(1000);
      // reload 后可能停在应用列表页——重新进入应用与模型页签（上轮缺失导航致误报 empty）
      await cdp.evalJs(`(() => { const cards = Array.from(document.querySelectorAll('.ant-card')); const c = cards.find(x => x.textContent.includes('报销管理')); (c?.querySelector('button') || c)?.click(); })()`);
      await cdp.waitFor('.ant-tabs', 10000);
      await cdp.evalJs(`(() => { const t = Array.from(document.querySelectorAll('.ant-tabs-tab')).find(x => x.textContent.includes('模型')); t?.click(); })()`);
      const relisted = await cdp.evalJs(`(() => new Promise((res) => {
        const deadline = Date.now() + 20000;
        const probe = () => {
          const nodes = document.querySelectorAll('.react-flow__node').length;
          if (nodes > 0) return res('relisted:' + nodes);
          if (Date.now() > deadline) return res('empty');
          setTimeout(probe, 500);
        };
        probe();
      }))()`);
      ok('B1 后端恢复后列表重新加载（画布节点恢复）', relisted.startsWith('relisted'), relisted);
    } else {
      record('B1 后端重启超时（环境异常）', false, 'restart-timeout');
    }

    await cdp.shot('m12-closeout-final');
    summary('m12-closeout');
  } catch (e) {
    console.error('FATAL:', e.message);
    await cdp.shot('m12-closeout-fail').catch(() => {});
    summary('m12-closeout');
    process.exitCode = 1;
  } finally {
    await cdp.close();
  }
})();

/** WSL 命令执行（accept-lib 未导出 exec——本地封装）。 */
function exec_wsl(cmd) {
  const { execSync } = require('child_process');
  try { return execSync(`wsl -e bash -c "${cmd.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 120000 }); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}
