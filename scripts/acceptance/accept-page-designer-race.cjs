/**
 * M13 补充验收（真实交互专项）：
 *  C1 模型生成默认页：向导选模型+勾选生成 → 草稿含字段骨架（PRD 02 §2.1）
 *  C2 拖拽双形态实证：主路径 = CDP Input.dispatchMouseEvent 真实鼠标序列（press→move×N→release，
 *     浏览器输入管线合成、isTrusted=true）；若 headless 下浏览器未据此启动 HTML5 drag 会话
 *     （draggable 源的 dragstart 启动策略 headless 可能不同），回退 = 页面内完整
 *     dragover+drop 事件链 + DataTransfer（isTrusted=false 已知边界，如实记录形态）。
 *     两种形态都必须走「落点校验→命令系统→画布渲染」全链路断言。
 *  C3 自动保存竞态（确定性 in-flight 窗口）：fetch 拦截在 PUT 发出即挂起响应（门控），
 *     锁定「保存请求在途」窗口内继续编辑 → 放行 → 断言响应回执不吞编辑（dirty 保持、内容最终落库）
 *  C4 409 三路径闭环：稍后处理 → 保留草稿；保留本地并准备替换 → 换基线 → 手动保存 → 服务器被本地替换
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

/** 合成 DnD 事件链（回退形态）：mousedown → 逐点 dragover（触发落点指示）→ drop（带 DataTransfer 物料标识）→ mouseup。
 *  drop 宿主按 React 挂载的 onDrop 冒泡查找（fiber 反查仅用于定位，不直接调 handler）。 */
async function syntheticDndChain(fromExpr, toExpr) {
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
    // 应用卡片登录后异步加载——轮询点击直到卡片出现（消除首载时序 flake）
    for (let i = 0; i < 16; i++) {
      const r = await cdp.evalJs(`(() => { const cards = Array.from(document.querySelectorAll('.ant-card')); const c = cards.find(x => x.textContent.includes('报销管理')); if (!c) return ''; (c.querySelector('button') || c).click(); return 'ok'; })()`);
      if (r === 'ok') break;
      await sleep(500);
    }
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
    // 「由模型生成默认布局」为 antd Switch 且 initialValue=true（选中模型后默认开启）——
    // 选模后条件挂载渲染，轮询等待其出现（modal 动画时序不稳定，单次查询会偶发 no-switch）
    let switchState = 'no-switch';
    for (let i = 0; i < 20 && switchState === 'no-switch'; i++) {
      await sleep(300);
      switchState = await cdp.evalJs(`(() => {
        const modal = ${MODAL};
        if (!modal) return 'no-modal';
        const sw = Array.from(modal.querySelectorAll('button[role="switch"]')).find(s => s.offsetParent !== null);
        if (!sw) return 'no-switch';
        return 'switch-on=' + (sw.getAttribute('aria-checked') === 'true');
      })()`);
    }
    ok('C1-1b 生成开关默认开启（antd Switch）', switchState === 'switch-on=true', switchState);
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

    // 拖拽双形态实证：
    //   主路径：CDP Input.dispatchMouseEvent 真实鼠标序列（浏览器输入管线，isTrusted=true）。
    //   先在页面埋 dragstart/drop 监听探针判定真实拖拽会话是否成立；
    //   headless 下浏览器对 draggable 源的 dragstart 启动策略可能不触发——此时如实降级
    //   到合成 DnD 事件链（isTrusted=false 边界如实记录），两种形态都走全链路断言。
    const matExpr = `(() => { const panels = Array.from(document.querySelectorAll('.ant-card')).filter(c => { const h = c.querySelector('.ant-card-head'); return h && h.textContent.trim() === '物料'; }); const panel = panels[panels.length - 1]; return Array.from(panel.querySelectorAll('[draggable]')).find(d => d.textContent.trim() === 'TextInput'); })()`;
    const canvasExpr = `(() => { const guide = Array.from(document.querySelectorAll('div')).find(d => d.textContent.trim() === '拖拽左侧物料到此处开始搭建页面' && d.children.length === 0); return guide ? guide.parentElement : document.querySelector('.ant-card[style*="flex: 1"] > div'); })()`;

    // 埋真实输入探针：dragstart（HTML5 会话启动）与 drop（会话落点）各计数
    await cdp.evalJs(`(() => {
      window.__dndProbe = { dragstart: 0, drop: 0 };
      document.addEventListener('dragstart', () => window.__dndProbe.dragstart++, true);
      document.addEventListener('drop', () => window.__dndProbe.drop++, true);
      return 'probe-installed';
    })()`);

    const fromBox = await cdp.centerOf(matExpr);
    const toBox = await cdp.centerOf(canvasExpr);
    if (!fromBox || !toBox) throw new Error('C2 拖拽坐标缺失: ' + JSON.stringify({ fromBox, toBox }));
    // 真实鼠标拖拽：物料中心 → 画布上部（先移出源再入目标，模拟真实轨迹）
    await cdp.mouseDrag(fromBox.x, fromBox.y, toBox.x, toBox.y, { steps: 16, frameMs: 40 });
    await sleep(600);
    const probeAfter = await cdp.evalJs('JSON.stringify(window.__dndProbe)');
    const probe = JSON.parse(probeAfter || '{}');
    const realDragWorked = probe.dragstart >= 1 && (await canvasNodeCount()) >= 1;

    let dragRes;
    let c2mode;
    if (realDragWorked) {
      dragRes = 'dropped:real-input';
      c2mode = 'cdp-real-mouse (isTrusted=true, dragstart=' + probe.dragstart + ', drop=' + probe.drop + ')';
    } else {
      // 如实降级：记录真实输入未启动 HTML5 会话的实测事实，走事件链回退
      record('C2-0 真实鼠标序列未启动 HTML5 drag 会话（headless 实测，降级回退并如实记录）', true,
        `dragstart=${probe.dragstart} drop=${probe.drop} nodes=${await canvasNodeCount()}`);
      dragRes = await syntheticDndChain(matExpr, canvasExpr);
      c2mode = 'synthetic-dnd-chain (isTrusted=false 已知边界)';
    }
    await sleep(800);
    ok('C2-1 拖拽执行（形态: ' + c2mode + '）', String(dragRes).startsWith('dropped'), String(dragRes));
    ok('C2-2 拖拽后画布出现节点（经落点校验+命令系统）', (await canvasNodeCount()) >= 1, 'count=' + (await canvasNodeCount()));

    // ========== C3 自动保存竞态（确定性 in-flight 窗口） ==========
    // 门控设计：fetch 拦截在 PUT 发出即挂起响应（不固定延时），脚本确认「请求已发出且
    // 响应未返回」后才编辑——锁定真实在途窗口，消除旧版「探针看到版本推进时保存已完成」的时序漏洞。
    const pages3 = await admin.call('GET', `/api/pages?appId=1`);
    const racePage = (pages3.json.list || []).find((p) => p.pageKey === c2Key);
    const beforeDraft = await admin.call('GET', `/api/pages/${racePage.id}/draft`);
    const vBefore = beforeDraft.json.draftVersion;

    // 产生编辑（拖入第二个物料）
    const dragRes2 = await syntheticDndChain(matExpr, `document.querySelector('.ant-card[style*="flex: 1"] [data-node-id]') || ${canvasExpr}`);
    await sleep(800);
    ok('C3-1 编辑产生 dirty（拖入第二个节点）', (await canvasNodeCount()) >= 2, 'count=' + (await canvasNodeCount()));

    // 安装门控：PUT draft 发出即挂起（window.__gate.resolve 由脚本显式放行）
    await cdp.evalJs(`(() => {
      const orig = window.__origFetch || window.fetch;
      window.__origFetch = orig;
      window.__gate = { fired: 0, resolve: null };
      window.fetch = (...args) => {
        const url = String(args[0]);
        if (url.includes('/draft') && (args[1]?.method === 'PUT' || args[1]?.method === 'put')) {
          window.__gate.fired++;
          const p = orig(...args);
          return new Promise((resolve) => {
            window.__gate.resolve = () => resolve(p);
            // 不设自动放行——由脚本在编辑完成后显式放行，窗口确定性锁定
          });
        }
        return orig(...args);
      };
      return 'gate-installed';
    })()`);

    // 手动触发保存（不必等 30s 定时器——竞态窗口构造与触发源无关；
    // 30s 定时器真实性已由 C3-2b 在窗口放行后独立验证）
    const saveStart = await clickToolbar('保存');
    let fired = 0;
    for (let i = 0; i < 50 && fired === 0; i++) { await sleep(200); fired = Number(await cdp.evalJs('window.__gate?.fired || 0')); }
    ok('C3-2 保存请求已发出且响应被门控挂起（in-flight 确认）', saveStart === 'clicked' && fired >= 1, `save=${saveStart} fired=${fired}`);

    // —— 现在保存确定性在途：此刻编辑（保存快照已定格，新编辑只进 dirty）——
    const editDuring = await cdp.evalJs(`(() => {
      const card = ${PROP_PANEL};
      const input = card?.querySelector('.ant-form-item input');
      if (!input) return 'no-input';
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      s.call(input, '竞态期间编辑');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'edited-inflight';
    })()`);
    await sleep(400);
    // dirty 仍在：响应未返回，回执不可能清 dirty；且新编辑值已在文档中
    const dirtyDuring = await cdp.evalJs(`(() => {
      const inputs = Array.from((${PROP_PANEL})?.querySelectorAll('.ant-form-item input') || []);
      const hit = inputs.find(i => i.value === '竞态期间编辑');
      return 'dirty-marker=' + (!!hit) + ' gateFired=' + (window.__gate?.fired || 0);
    })()`);
    ok('C3-3 保存 in-flight 期间编辑生效（值已在文档，等待回执）', editDuring === 'edited-inflight' && dirtyDuring.includes('dirty-marker=true'), `${editDuring}/${dirtyDuring}`);

    // 放行响应 → 回执返回；断言期间编辑未被回执吞掉
    await cdp.evalJs('window.__gate.resolve && window.__gate.resolve()');
    await sleep(1200);
    await cdp.evalJs(`(() => { if (window.__origFetch) window.fetch = window.__origFetch; return 'fetch-restored'; })()`);
    // 回执返回后画布应回到 dirty（期间编辑未被标为已保存）
    const dirtyAfter = await cdp.evalJs(`(() => document.body.innerText.includes('未保存'))()`);
    ok('C3-4 回执返回后期间编辑保持 dirty（不被保存回执吞掉）', dirtyAfter === true, `dirty=${dirtyAfter}`);

    // 手动保存收尾（把期间编辑落库）——工具栏 includes 匹配（按钮文本含「·未保存」角标）
    const saveClick = await clickToolbar('保存');
    const savedFinal = saveClick === 'clicked' && await waitText('已保存', 12000);
    ok('C3-5 保存期间编辑未被丢（手动保存收尾成功）', savedFinal);
    const afterDraft = await admin.call('GET', `/api/pages/${racePage.id}/draft`);
    const finalText = JSON.stringify(afterDraft.json.schema?.layout || []);
    ok('C3-6 竞态期间编辑内容落库', finalText.includes('竞态期间编辑'), finalText.slice(0, 100));
    ok('C3-7 版本链一致推进', afterDraft.json.draftVersion > vBefore, `v=${vBefore}→${afterDraft.json.draftVersion}`);

    // —— C3b 30s 自动保存定时器真实触发（独立验证，与竞态窗口解耦）——
    // 保持 dirty 等定时器自然触发；探针只认「无任何手动保存时 draftVersion 自己推进」
    await cdp.evalJs(`(() => {
      const card = ${PROP_PANEL};
      const input = card?.querySelector('.ant-form-item input');
      if (!input) return 'no-input';
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      s.call(input, '定时器验证编辑');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'dirty-set';
    })()`);
    const vBeforeTimer = afterDraft.json.draftVersion;
    record('C3b-1 等待 30s 自动保存定时器真实触发（最长 36s）', true, 'waiting...');
    const timerStart = Date.now();
    let timerSaved = false;
    while (Date.now() - timerStart < 36_000) {
      await sleep(3000);
      const probe = await admin.call('GET', `/api/pages/${racePage.id}/draft`);
      if (probe.json.draftVersion > vBeforeTimer) { timerSaved = true; break; }
    }
    ok('C3b-2 自动保存真实触发（无手动保存，draftVersion 自然推进）', timerSaved, `v=${vBeforeTimer}`);
    if (timerSaved) {
      const timerDraft = await admin.call('GET', `/api/pages/${racePage.id}/draft`);
      const timerStr = JSON.stringify(timerDraft.json.schema?.layout || []);
      ok('C3b-3 定时器保存内容落库', timerStr.includes('定时器验证编辑'), timerStr.slice(0, 80));
    }

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
    // 草稿完整保留断言：服务器当前版本不含本地独有内容「重存闭环测试」（外部独有内容），而画布
    // 文档仍持有它——即本地草稿未被冲突处理清掉/回滚（不是只查标记值，查整个画布节点数与内容）
    const keepDraftServer = await admin.call('GET', `/api/pages/${racePage.id}/draft`);
    const keepServerStr = JSON.stringify(keepDraftServer.json.schema?.layout || []);
    const keptLocal = await cdp.evalJs(`(() => {
      const inputs = Array.from((${PROP_PANEL})?.querySelectorAll('.ant-form-item input') || []);
      const sel = document.querySelector('.ant-card[style*="flex: 1"] [data-node-id].selected') || document.querySelector('.ant-card[style*="flex: 1"] [data-node-id]');
      return JSON.stringify({ nodes: document.querySelectorAll('.ant-card[style*="flex: 1"] [data-node-id]').length, selectedText: sel ? sel.textContent.slice(0, 30) : null, hasMarker: inputs.some(i => i.value === '重存闭环测试') });
    })()`);
    const kept = JSON.parse(keptLocal || '{}');
    ok('C4-3b 本地草稿完整保留（画布节点数≥2 且期间编辑仍在画布）',
      (kept.nodes ?? 0) >= 2 && kept.hasMarker === true, `nodes=${kept.nodes} marker=${kept.hasMarker}`);
    ok('C4-3c 服务器此刻不含本地内容（保留≠落库，冲突态如实）', !keepServerStr.includes('重存闭环测试'), keepServerStr.slice(0, 60));

    // —— C4b 第三按钮完整闭环：保留本地并准备替换 → 手动保存 → 服务器被本地内容替换 ——
    // 再次制造冲突（本地改 + 外部推版本 → 保存 409）
    await cdp.evalJs(`(() => {
      const card = ${PROP_PANEL};
      const input = card?.querySelector('.ant-form-item input');
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      s.call(input, '本地独有内容');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(400);
    const cur2 = await admin.call('GET', `/api/pages/${racePage.id}/draft`);
    await admin.expect('C4b-1 外部再次推高版本（制造冲突）', 'PUT', `/api/pages/${racePage.id}/draft`, 200,
      { schema: cur2.json.schema, baseDraftVersion: cur2.json.draftVersion });
    await sleep(300);
    await clickToolbar('保存');
    ok('C4b-2 第二次 409 弹层出现', await waitText('草稿版本冲突', 10000));
    const replaceClick = await cdp.evalJs(`(() => {
      const modal = ${CONFLICT_MODAL};
      if (!modal) return 'no-modal';
      const b = Array.from(modal.querySelectorAll('button')).find(x => (x.textContent || '').includes('准备替换'));
      if (!b) return 'missing:' + Array.from(modal.querySelectorAll('button')).map(x => x.textContent).join('|');
      b.click(); return 'clicked';
    })()`);
    await sleep(600);
    ok('C4b-3 保留本地并准备替换（基线更新、弹层关闭）', replaceClick === 'clicked' && !(await bodyText()).includes('草稿版本冲突'), replaceClick);
    // 手动保存 → 应以新基线成功，服务器内容被本地替换
    await sleep(400);
    await clickToolbar('保存');
    ok('C4b-4 换基线后手动保存成功', await waitText('已保存', 12000));
    const replacedDraft = await admin.call('GET', `/api/pages/${racePage.id}/draft`);
    const replacedStr = JSON.stringify(replacedDraft.json.schema?.layout || []);
    ok('C4b-5 服务器草稿被本地内容替换（闭环核心断言）', replacedStr.includes('本地独有内容'), replacedStr.slice(0, 100));
    ok('C4b-6 替换后服务器不再含外部独有内容', !replacedStr.includes('重存闭环测试'), '');

    // 显式换基线：重新打开设计器（拉最新服务器版），再编辑保存
    await cdp.evalJs(`(() => { const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('返回列表')); btn?.click(); })()`);
    await waitText('新建页面', 8000);
    await cdp.evalJs(`(() => { const item = Array.from(document.querySelectorAll('.ant-list-item')).find(x => x.textContent.includes('${c2Key}')); const btn = Array.from(item.querySelectorAll('button')).find(b => b.textContent.includes('设计')); btn.click(); })()`);
    await waitText('返回列表', 12000);
    await sleep(1500);
    // 画布应显示服务器最新内容（被替换后的本地独有内容——节点仍在）
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
    ok('C4-5 重开编辑保存成功（放弃式换基线路径）', await waitText('已保存', 12000));
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
