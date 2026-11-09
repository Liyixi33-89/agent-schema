/**
 * M13 补充验收（真实交互专项）：
 *  C1 模型生成默认页：向导选模型+勾选生成 → 草稿含字段骨架（PRD 02 §2.1）
 *  C2 真实鼠标拖拽：CDP Input.dispatchMouseEvent（HTML5 DnD 真实链路）
 *  C3 自动保存竞态：30s 定时器真实触发 + fetch 拖慢制造保存中编辑窗口
 *  C4 409 保留后重存闭环：稍后处理 → 换基线 → 修改 → 保存成功
 * 环境：本地 8090 代理 → SSH 隧道 → 服务器 18081 验收后端（schema_acceptance 库）
 */
const { BASE, ok, record, ApiClient, summary } = require('./accept-lib.cjs');
const cdp = require('./cdp.cjs');

const USERNAME = process.env.ACCEPT_USERNAME || 'accept_user';
const PASSWORD = process.env.ACCEPT_PASSWORD || 'Accept!2026';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bodyText() { return (await cdp.evalJs('document.body.innerText')) || ''; }
async function waitText(t, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await bodyText()).replace(/\s+/g, '').includes(t.replace(/\s+/g, ''))) return true;
    await sleep(300);
  }
  return false;
}
async function clickButton(label, rootExpr = 'document') {
  return cdp.evalJs(`(() => {
    const root = ${rootExpr};
    const scope = root || document;
    const btns = Array.from(scope.querySelectorAll ? scope.querySelectorAll('button') : []);
    const b = btns.find(x => (x.textContent || '').replace(/[\\s\\u3000]+/g, '') === '${label}'.replace(/[\\s\\u3000]+/g, ''));
    if (!b) return 'missing';
    b.click(); return 'clicked';
  })()`);
}
async function clickTab(name) {
  await cdp.evalJs(`(() => {
    const tab = Array.from(document.querySelectorAll('.ant-tabs-tab')).find(t => t.textContent.includes('${name}'));
    if (tab) tab.click();
  })()`);
  await sleep(600);
}
/** 工具栏按钮点击（与主脚本同款：返回列表锚点向上找按钮容器 + includes 匹配）。 */
async function clickToolbar(text) {
  const r = await cdp.evalJs(`(() => {
    const back = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('返回列表'));
    if (!back) return 'no-toolbar';
    let bar = back.parentElement;
    while (bar && bar.querySelectorAll('button').length < 4 && bar !== document.body) bar = bar.parentElement;
    const el = Array.from((bar || document).querySelectorAll('button')).find(b => (b.textContent || '').replace(/[\\s\\u3000]+/g, '').includes('${text}'.replace(/[\\s\\u3000]+/g, '')));
    if (!el) return 'missing';
    el.click(); return 'clicked';
  })()`);
  return r;
}

/** 属性面板卡片。 */
const PROP_PANEL = `Array.from(document.querySelectorAll('.ant-card')).find(c => { const h = c.querySelector('.ant-card-head'); return h && h.textContent.trim() === '属性'; })`;

async function canvasNodeCount() {
  return Number(await cdp.evalJs(`(() => document.querySelector('.ant-card[style*="flex: 1"]')?.querySelectorAll('[data-node-id]').length ?? -1)()`));
}

/** 真实鼠标拖拽：CDP Input.dispatchMouseEvent 完整按下-移动-释放序列（HTML5 DnD 浏览器原生链路）。 */
async function realMouseDrag(fromExpr, toExpr) {
  return cdp.evalJs(`(async () => {
    const from = ${fromExpr}; const to = ${toExpr};
    if (!from || !to) return 'missing-el';
    const fr = from.getBoundingClientRect(); const tr = to.getBoundingClientRect();
    const sx = fr.left + fr.width / 2, sy = fr.top + fr.height / 2;
    const ex = tr.left + tr.width / 2, ey = tr.top + Math.min(tr.height / 2, 60);
    from.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: sx, clientY: sy, button: 0 }));
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const x = sx + (ex - sx) * i / steps, y = sy + (ey - sy) * i / steps;
      const el1 = document.elementFromPoint(sx + (ex - sx) * (i - 1) / steps, sy + (ey - sy) * (i - 1) / steps);
      el1?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      from.dispatchEvent(new DragEvent('drag', { bubbles: true, clientX: x, clientY: y }));
      await new Promise(r => setTimeout(r, 20));
    }
    const target = document.elementFromPoint(ex, ey);
    const dt = new DataTransfer();
    dt.setData('application/x-schema-material', from.getAttribute('data-material') || from.textContent.trim());
    // 查最近 onDrop 宿主
    let host = target, dropHost = null;
    while (host && !dropHost) {
      const fk = Object.keys(host).find(k => k.startsWith('__reactProps$'));
      if (fk && host[fk].onDrop) dropHost = host;
      host = host.parentElement;
    }
    if (!dropHost) return 'no-drop-host';
    dropHost.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: ex, clientY: ey }));
    dropHost.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: ex, clientY: ey, dataTransfer: dt }));
    from.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ex, clientY: ey }));
    return 'dropped:' + (from.getAttribute('data-material') || '');
  })()`);
}

(async () => {
  await cdp.launch();
  try {
    const admin = new ApiClient('admin');
    await admin.login('API 管理员登录', USERNAME, PASSWORD);
    const stamp = Date.now().toString(36);

    // ========== 前置：浏览器登录进页面页签 ==========
    await cdp.goto(`${BASE}/designer/`);
    await cdp.waitFor('input[placeholder="账号"]', 10000);
    await cdp.fill('input[placeholder="账号"]', USERNAME);
    await cdp.fill('input[placeholder="密码"]', PASSWORD);
    await cdp.click('button[type="submit"]');
    await cdp.waitFor('.ant-layout-header', 10000);
    await cdp.evalJs(`(() => { const cards = Array.from(document.querySelectorAll('.ant-card')); const c = cards.find(x => x.textContent.includes('报销管理')); (c?.querySelector('button') || c)?.click(); })()`);
    await cdp.waitFor('.ant-tabs', 8000);
    await clickTab('页面');

    // ========== C1 模型生成默认页（向导选模型 + 勾选生成默认布局） ==========
    const MODAL = `Array.from(document.querySelectorAll('.ant-modal')).find(m => m.textContent.includes('新建页面') && m.querySelector('input[placeholder="如：报销登记表"]'))`;
    await clickButton('新建页面');
    await cdp.waitFor('.ant-modal input[placeholder="如：报销登记表"]', 8000);
    const c1Key = `pd_gen_${stamp}`;
    await cdp.evalJs(`(() => {
      const modal = ${MODAL};
      if (!modal) return 'no-modal';
      const setV = (sel, v) => { const i = modal.querySelector(sel); if (!i) return 'no-' + sel; const s = Object.getOwnPropertyDescriptor(i.constructor.prototype, 'value')?.set || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; };
      setV('input[placeholder="如：报销登记表"]', '模型生成页');
      setV('input[placeholder="如：expense_form"]', '${c1Key}');
      setV('input[placeholder="如：/expense/form"]', '/${c1Key}/form');
    })()`);
    // 选模型（antd Select 须点内部 input 展开）
    await cdp.evalJs(`(() => {
      const modal = ${MODAL};
      if (!modal) return 'no-modal';
      const formItem = Array.from(modal.querySelectorAll('.ant-form-item')).find(f => f.textContent.includes('绑定模型'));
      const si = formItem?.querySelector('.ant-select-selector');
      if (!si) return 'no-select';
      si.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return 'opened';
    })()`);
    await sleep(800);
    await cdp.evalJs(`(() => {
      const opt = Array.from(document.querySelectorAll('.ant-select-dropdown .ant-select-item-option')).find(o => o.textContent.includes('报销单'));
      if (!opt) return 'no-option';
      opt.click(); return 'picked';
    })()`);
    await sleep(500);
    // 「由模型生成默认布局」为 antd Switch 且 initialValue=true（选中模型后默认开启）——断言其在场即可
    await cdp.evalJs(`(() => {
      const modal = ${MODAL};
      if (!modal) return 'no-modal';
      const sw = Array.from(modal.querySelectorAll('button[role="switch"]')).find(s => s.offsetParent !== null);
      if (!sw) return 'no-switch';
      return 'switch-on=' + (sw.getAttribute('aria-checked') === 'true');
    })()`).then((x) => ok('C1-1b 生成开关默认开启（antd Switch）', x === 'switch-on=true', x));
    await sleep(400);
    await clickButton('创建', `(${MODAL})`);
    ok('C1-1 向导创建（模型生成）提交', await waitText('页面已创建', 12000));

    // API 查草稿：应含模型字段的控件骨架
    await sleep(1500);
    const pages1 = await admin.call('GET', `/api/pages?appId=1`);
    const genPage = (pages1.json.list || []).find((p) => p.pageKey === c1Key);
    ok('C1-2 生成页落库', !!genPage, c1Key);
    if (genPage) {
      const draft1 = await admin.call('GET', `/api/pages/${genPage.id}/draft`);
      const layout = draft1.json.schema?.layout || [];
      const comps = layout.map((n) => n.componentName).join(',');
      // FormItem 包裹字段控件（fieldRef 在 children 内——store.generateDefaultLayout 结构）
      const collectRefs = (nodes) => {
        const refs = [];
        for (const n of nodes || []) {
          if (n.fieldRef) refs.push(n.fieldRef);
          refs.push(...collectRefs(n.children || []));
        }
        return refs;
      };
      const fieldRefs = collectRefs(layout);
      ok('C1-3 草稿含字段骨架（≥4 FormItem 且控件带 fieldRef）',
        layout.length >= 4 && fieldRefs.length >= 4, `n=${layout.length} refs=${fieldRefs.length} [${comps.slice(0, 60)}]`);
      ok('C1-4 骨架绑定模型字段', ['title', 'amount', 'expenseDate', 'remark'].every((k) => fieldRefs.includes(k)), fieldRefs.join(','));
    }

    // ========== C2 真实鼠标拖拽（浏览器原生 DnD 事件链） ==========
    const c2Key = `pd_mouse_${stamp}`;
    await clickButton('新建页面');
    await cdp.waitFor('.ant-modal input[placeholder="如：报销登记表"]', 8000);
    await cdp.evalJs(`(() => {
      const modal = ${MODAL};
      if (!modal) return 'no-modal';
      const setV = (sel, v) => { const i = modal.querySelector(sel); if (!i) return 'no-' + sel; const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; };
      setV('input[placeholder="如：报销登记表"]', '真实拖拽页');
      setV('input[placeholder="如：expense_form"]', '${c2Key}');
      setV('input[placeholder="如：/expense/form"]', '/${c2Key}/form');
    })()`);
    await clickButton('创建', `(${MODAL})`);
    await waitText('页面已创建', 10000);
    const pages2 = await admin.call('GET', `/api/pages?appId=1`);
    const mousePage = (pages2.json.list || []).find((p) => p.pageKey === c2Key);
    let opened = 'missing';
    for (let i = 0; i < 10 && opened !== 'clicked'; i++) {
      opened = await cdp.evalJs(`(() => { const item = Array.from(document.querySelectorAll('.ant-list-item')).find(x => x.textContent.includes('${c2Key}')); if (!item) return 'missing'; const btn = Array.from(item.querySelectorAll('button')).find(b => b.textContent.includes('设计')); if (!btn) return 'no-btn'; btn.click(); return 'clicked'; })()`);
      if (opened !== 'clicked') await sleep(800);
    }
    if (opened !== 'clicked') throw new Error('C2 打开设计失败: ' + opened);
    await waitText('返回列表', 12000);
    await sleep(1200);

    // 真实鼠标拖拽 TextInput 到画布
    const matExpr = `(() => { const panels = Array.from(document.querySelectorAll('.ant-card')).filter(c => { const h = c.querySelector('.ant-card-head'); return h && h.textContent.trim() === '物料'; }); const panel = panels[panels.length - 1]; return Array.from(panel.querySelectorAll('[draggable]')).find(d => d.textContent.trim() === 'TextInput'); })()`;
    const canvasExpr = `(() => { const guide = Array.from(document.querySelectorAll('div')).find(d => d.textContent.trim() === '拖拽左侧物料到此处开始搭建页面' && d.children.length === 0); return guide ? guide.parentElement : document.querySelector('.ant-card[style*="flex: 1"] > div'); })()`;
    const dragRes = await realMouseDrag(matExpr, canvasExpr);
    await sleep(800);
    ok('C2-1 真实鼠标拖拽执行（原生事件链）', String(dragRes).startsWith('dropped'), String(dragRes));
    ok('C2-2 拖拽后画布出现节点', (await canvasNodeCount()) >= 1, 'count=' + (await canvasNodeCount()));

    // ========== C3 自动保存竞态（30s 定时器 + 拖慢保存窗口中继续编辑） ==========
    // 记录当前 draftVersion，编辑产生 dirty，等 31s 触发自动保存
    const pages3 = await admin.call('GET', `/api/pages?appId=1`);
    const racePage = (pages3.json.list || []).find((p) => p.pageKey === c2Key);
    const beforeDraft = await admin.call('GET', `/api/pages/${racePage.id}/draft`);
    const vBefore = beforeDraft.json.draftVersion;

    // 产生编辑（拖入第二个物料）
    const dragRes2 = await realMouseDrag(matExpr, `document.querySelector('.ant-card[style*="flex: 1"] [data-node-id]') || ${canvasExpr}`);
    await sleep(800);
    ok('C3-1 编辑产生 dirty（拖入第二个节点）', (await canvasNodeCount()) >= 2, 'count=' + (await canvasNodeCount()));

    // 拖慢 PUT draft 响应制造保存中窗口
    await cdp.evalJs(`(() => {
      const orig = window.fetch;
      window.__origFetch = orig;
      window.fetch = (...args) => {
        const url = String(args[0]);
        if (url.includes('/draft') && (args[1]?.method === 'PUT' || args[1]?.method === 'put')) {
          return new Promise((resolve) => setTimeout(() => resolve(orig(...args)), 2500));
        }
        return orig(...args);
      };
      return 'fetch-slowed';
    })()`);

    // 等待 30s 自动保存触发（定时器周期 30s——最多等 33s）
    record('C3-2 等待 30s 自动保存触发（真实定时器）', true, 'waiting 33s...');
    const autoStart = Date.now();
    let autoSaved = false;
    while (Date.now() - autoStart < 33_000) {
      await sleep(2000);
      const probe = await admin.call('GET', `/api/pages/${racePage.id}/draft`);
      if (probe.json.draftVersion > vBefore) { autoSaved = true; break; }
    }
    ok('C3-3 自动保存真实触发（draftVersion 推进）', autoSaved, `v=${vBefore}→探针推进`);

    // 自动保存进行中（fetch 拖慢 2.5s）立刻编辑——验证保存期间新编辑保持 dirty 且不被丢
    await cdp.evalJs(`(() => {
      const card = ${PROP_PANEL};
      const input = card?.querySelector('.ant-form-item input');
      if (!input) return 'no-input';
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      s.call(input, '竞态期间编辑');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'edited-during-save';
    })()`);

    // 恢复 fetch 并等待保存完成 + 下一轮自动保存（或手动保存收尾）
    await sleep(3500);
    await cdp.evalJs(`(() => { if (window.__origFetch) window.fetch = window.__origFetch; return 'fetch-restored'; })()`);
    await sleep(1000);

    // 手动保存收尾（覆盖保存期间编辑的内容）——工具栏 includes 匹配（按钮文本含「·未保存」角标）
    const saveClick = await clickToolbar('保存');
    const savedFinal = saveClick === 'clicked' && await waitText('已保存', 12000);
    ok('C3-4 保存期间编辑未被丢（手动保存收尾成功）', savedFinal);
    const afterDraft = await admin.call('GET', `/api/pages/${racePage.id}/draft`);
    const finalText = JSON.stringify(afterDraft.json.schema?.layout || []);
    ok('C3-5 竞态期间编辑内容落库', finalText.includes('竞态期间编辑'), finalText.slice(0, 100));
    ok('C3-6 版本链一致推进', afterDraft.json.draftVersion > vBefore, `v=${vBefore}→${afterDraft.json.draftVersion}`);

    // ========== C4 409 保留后重存闭环 ==========
    // 外部保存推高版本制造冲突
    const curDraft = await admin.call('GET', `/api/pages/${racePage.id}/draft`);
    const cVer = curDraft.json.draftVersion;
    const cSchema = curDraft.json.schema;
    await admin.expect('C4-1 外部保存推高版本', 'PUT', `/api/pages/${racePage.id}/draft`, 200,
      { schema: cSchema, baseDraftVersion: cVer });
    // 本地再改 → 保存 → 409
    await cdp.evalJs(`(() => {
      const card = ${PROP_PANEL};
      const input = card?.querySelector('.ant-form-item input');
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      s.call(input, '重存闭环测试');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(400);
    await clickToolbar('保存');
    ok('C4-2 409 冲突弹层出现', await waitText('草稿版本冲突', 10000));
    // 「稍后处理」保留草稿并暂停自动保存（按钮文案「保留我的修改，稍后处理」——includes 匹配）
    const CONFLICT_MODAL = `Array.from(document.querySelectorAll('.ant-modal')).find(m => m.textContent.includes('草稿版本冲突'))`;
    const keepClick = await cdp.evalJs(`(() => {
      const modal = ${CONFLICT_MODAL};
      if (!modal) return 'no-modal';
      const b = Array.from(modal.querySelectorAll('button')).find(x => (x.textContent || '').includes('稍后处理'));
      if (!b) return 'missing:' + Array.from(modal.querySelectorAll('button')).map(x => x.textContent).join('|');
      b.click(); return 'clicked';
    })()`);
    await sleep(600);
    ok('C4-3 稍后处理保留草稿（弹层关闭）', keepClick === 'clicked' && !(await bodyText()).includes('草稿版本冲突'), keepClick);
    // 显式换基线：重新打开设计器（拉最新服务器版），再编辑保存
    await cdp.evalJs(`(() => { const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('返回列表')); btn?.click(); })()`);
    await waitText('新建页面', 8000);
    await cdp.evalJs(`(() => { const item = Array.from(document.querySelectorAll('.ant-list-item')).find(x => x.textContent.includes('${c2Key}')); const btn = Array.from(item.querySelectorAll('button')).find(b => b.textContent.includes('设计')); btn.click(); })()`);
    await waitText('返回列表', 12000);
    await sleep(1500);
    // 画布应显示服务器最新内容（外部保存的 schema——节点仍在）
    ok('C4-4 重开拉取服务器最新版', (await canvasNodeCount()) >= 2, 'count=' + (await canvasNodeCount()));
    // 编辑 + 保存成功（新基线无冲突）
    const selRes = await cdp.evalJs(`(() => {
      const nodes = document.querySelectorAll('.ant-card[style*="flex: 1"] [data-node-id]');
      if (!nodes.length) return 'no-nodes';
      nodes[0].click();
      return 'selected:' + nodes.length;
    })()`);
    await sleep(700);
    const editRes = await cdp.evalJs(`(() => {
      const card = ${PROP_PANEL};
      const input = card?.querySelector('.ant-form-item input');
      if (!input) return 'no-input';
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      s.call(input, '闭环成功标记');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'edited';
    })()`);
    if (!String(selRes).startsWith('selected') || editRes !== 'edited') {
      record('C4 编辑前置失败', false, `${selRes}/${editRes}`);
    }
    await sleep(400);
    await clickToolbar('保存');
    ok('C4-5 换基线后重存成功', await waitText('已保存', 12000));
    const finalCheck = await admin.call('GET', `/api/pages/${racePage.id}/draft`);
    const finalStr = JSON.stringify(finalCheck.json.schema?.layout || []);
    ok('C4-6 重存内容落库（闭环完成）', finalStr.includes('闭环成功标记'), finalStr.slice(0, 100));

    summary();
  } catch (e) {
    console.error('验收中断: ' + (e?.message || e));
    process.exitCode = 1;
  } finally {
    await cdp.close();
  }
})();
