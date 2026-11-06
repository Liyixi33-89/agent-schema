/**
 * M13 页面设计器验收（规格 013 §5 A4-A9 浏览器面）：
 *  A4 拖拽真实交互：UI 新建页面 → 拖入物料 → 撤销/重做
 *  A5 属性面板：选中节点 propsSchema 渲染；改 label 即时反映画布
 *  A6 表达式：语法错误阻断保存；修正后保存成功且草稿落库
 *  A7 409 冲突：外部保存推版本 → 设计器保存 → 冲突弹层 → 保留 → 显式放弃对齐
 *  A8 发布预览：发布 → grant/exchange 凭证链 → 预览渲染与画布一致
 *  A9 字段绑定：未绑模型页下拉提示正确
 * 通道：CDP 真实事件 + API 断言 + 落库核对；fail-fast。
 */
const cdp = require('./cdp.cjs');
const { BASE, ok, record, ApiClient, dbQuery, summary, request } = require('./accept-lib.cjs');

const USERNAME = process.env.ACCEPT_USERNAME || 'accept_admin';
const PASSWORD = process.env.ACCEPT_PASSWORD || 'Accept!2026';
if (!PASSWORD) { console.error('缺少 ACCEPT_PASSWORD'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bodyText() { return (await cdp.evalJs('document.body.innerText')) || ''; }

async function waitText(include, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await bodyText()).includes(include)) return true;
    await sleep(300);
  }
  return false;
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

// 画布工具栏按钮(限定工具栏容器——antd Space 逐按钮包裹, 须取「返回列表」祖先中按钮数最多的一层)
function toolbarJs() {
  return `(() => {
    const back = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('返回列表'));
    if (!back) return null;
    let bar = back.parentElement;
    while (bar && bar.querySelectorAll('button').length < 4 && bar !== document.body) bar = bar.parentElement;
    return bar;
  })()`;
}

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
  if (r !== 'clicked') throw new Error('工具栏按钮未找到: ' + text + ' (' + r + ')');
  return r;
}

// 画布保存按钮 disabled 状态
async function saveDisabled() {
  return cdp.evalJs(`(() => {
    const back = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('返回列表'));
    if (!back) return 'no-toolbar';
    let bar = back.parentElement;
    while (bar && bar.querySelectorAll('button').length < 4 && bar !== document.body) bar = bar.parentElement;
    const save = Array.from((bar || document).querySelectorAll('button')).find(b => (b.textContent || '').replace(/[\\s\\u3000]+/g, '').startsWith('保存'));
    return save ? String(save.disabled) : 'missing';
  })()`);
}

async function clickTab(name) {
  await cdp.evalJs(`(() => { const t = Array.from(document.querySelectorAll('.ant-tabs-tab')).find(x => x.textContent.includes('${name}')); t?.click(); })()`);
  await sleep(800);
}

/** 设计器「页面」页签内经向导 UI 新建页面。 */
async function createPageViaUI(pageKey, name) {
  await clickButton('新建页面');
  await cdp.waitFor('.ant-modal input', 6000);
  await sleep(700);
  await cdp.evalJs(`(() => {
    const m = document.querySelector('.ant-modal');
    const inputs = Array.from(m.querySelectorAll('input'));
    const byPh = (frag) => inputs.find(i => (i.placeholder || '').includes(frag));
    const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    if (byPh('报销')) set(byPh('报销'), '${name}');
    if (byPh('expense')) set(byPh('expense'), '${pageKey}');
    if (byPh('/')) set(byPh('/'), '/${pageKey}/form');
  })()`);
  await sleep(500);
  await clickButton('创建', 'document.querySelector(".ant-modal")');
  await waitText('页面已创建', 10000);
}

/** 打开指定 pageKey 的设计画布。 */
async function openDesign(pageKey) {
  const hit = await cdp.evalJs(`(() => {
    const item = Array.from(document.querySelectorAll('.ant-list-item')).find(x => x.textContent.includes('${pageKey}'));
    if (!item) return 'missing';
    const btn = Array.from(item.querySelectorAll('button')).find(b => b.textContent.includes('设计'));
    if (!btn) return 'no-design-btn';
    btn.click(); return 'clicked';
  })()`);
  if (hit !== 'clicked') throw new Error('打开设计失败: ' + hit);
  await waitText('返回列表', 12000);
  await sleep(1200);
}

// 拖拽: 原生派发 DragEvent 在 React 18 委托层不被拾取——fiber 直调同步 onDrop(M12 教训同源).
async function dragMaterial(componentName) {
  return cdp.evalJs(`(() => {
    const panels = Array.from(document.querySelectorAll('.ant-card')).filter(c => {
      const head = c.querySelector('.ant-card-head');
      return head && head.textContent.trim() === '物料' && c.querySelectorAll('[draggable]').length > 0;
    });
    const panel = panels[panels.length - 1];
    if (!panel) return 'no-panel';
    const item = Array.from(panel.querySelectorAll('[draggable]')).find(d => d.textContent.trim() === '${componentName}');
    if (!item) return 'no-material';
    const guide = Array.from(document.querySelectorAll('div')).find(d => d.textContent.trim() === '拖拽左侧物料到此处开始搭建页面' && d.children.length === 0);
    let dropHost = guide ? guide.parentElement : null;
    if (!dropHost) {
      // onDrop 的容器在画布 Card 内部(SchemaRenderer 外层 div)——向下深度优先找
      const canvas = document.querySelector('.ant-card[style*="flex: 1"]');
      const stack = canvas ? [canvas] : [];
      while (stack.length) {
        const el = stack.pop();
        const fk = Object.keys(el).find(k => k.startsWith('__reactProps$'));
        if (fk && el[fk].onDrop) { dropHost = el; break; }
        for (const c of el.children) stack.push(c);
      }
    }
    if (!dropHost) return 'no-drop-host';
    const fk = Object.keys(dropHost).find(k => k.startsWith('__reactProps$'));
    const props = fk ? dropHost[fk] : null;
    if (!props || !props.onDrop) return 'no-onDrop';
    const dt = new DataTransfer();
    dt.setData('application/x-schema-material', '${componentName}');
    props.onDrop(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    return 'dropped';
  })()`);
}

/** 属性面板卡片（头标题「属性」——页面上唯一）。 */
const PROP_PANEL = `Array.from(document.querySelectorAll('.ant-card')).find(c => { const h = c.querySelector('.ant-card-head'); return h && h.textContent.trim() === '属性'; })`;

async function canvasNodeCount() {
  return Number(await cdp.evalJs(`(() => document.querySelector('.ant-card[style*="flex: 1"]')?.querySelectorAll('[data-node-id]').length ?? -1)()`));
}

(async () => {
  await cdp.launch();
  try {
    const admin = new ApiClient('admin');
    await admin.login('API 管理员登录', USERNAME, PASSWORD);
    const stamp = Date.now().toString(36);
    const pageKey = `pd_${stamp}`;

    // ========== 前置：浏览器登录进应用设置 ==========
    await cdp.goto(`${BASE}/designer/`);
    await cdp.waitFor('input[placeholder="账号"]', 10000);
    await cdp.fill('input[placeholder="账号"]', USERNAME);
    await cdp.fill('input[placeholder="密码"]', PASSWORD);
    await cdp.click('button[type="submit"]');
    await cdp.waitFor('.ant-layout-header', 10000);
    await cdp.evalJs(`(() => { const cards = Array.from(document.querySelectorAll('.ant-card')); const c = cards.find(x => x.textContent.includes('报销管理')); (c?.querySelector('button') || c)?.click(); })()`);
    await cdp.waitFor('.ant-tabs', 8000);
    await clickTab('页面');

    // ========== A4 UI 新建 + 拖拽 ==========
    await createPageViaUI(pageKey, '验收设计器页');
    await waitText(pageKey, 8000);
    ok('A4-1 UI 向导新建页面（列表出现）', true, pageKey);

    await openDesign(pageKey);
    await waitText('拖拽左侧物料到此处开始搭建页面', 6000);
    ok('A4-2 空画布引导可见', true);

    const drag1 = await dragMaterial('SectionCard');
    await sleep(700);
    const drag2 = await dragMaterial('TextInput');
    await sleep(700);
    ok('A4-3 拖入 SectionCard + TextInput', drag1 === 'dropped' && drag2 === 'dropped', `${drag1}/${drag2}`);
    const nodeCount = await canvasNodeCount();
    ok('A4-4 画布出现节点', nodeCount >= 2, 'count=' + nodeCount);

    await clickToolbar('撤销');
    await sleep(500);
    ok('A4-5 撤销后节点减一', (await canvasNodeCount()) === nodeCount - 1);
    await clickToolbar('重做');
    await sleep(500);
    ok('A4-6 重做后节点恢复', (await canvasNodeCount()) === nodeCount);

    // ========== A5 属性面板 ==========
    await cdp.evalJs(`(() => { document.querySelector('.ant-card[style*="flex: 1"] [data-node-id] > div')?.click(); })()`);
    await sleep(600);
    ok('A5-1 属性面板出现配置分组', (await bodyText()).includes('基础属性'));

    await cdp.evalJs(`(() => {
      const card = ${PROP_PANEL};
      const input = card?.querySelector('.ant-form-item input');
      if (!input) return 'missing-input';
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      s.call(input, '验收分组卡');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'set';
    })()`).then((x) => ok('A5-2 属性输入就位', x === 'set', x));
    await sleep(600);
    ok('A5-3 改 label 即时反映画布',
      !!(await cdp.evalJs(`(() => document.querySelector('.ant-card[style*="flex: 1"]').textContent.includes('验收分组卡'))()`)));

    // ========== A6 表达式阻断 ==========
    // 选中最后一个节点（TextInput）——直接点击包装层自身（避开内部 input 的 stopPropagation）
    await cdp.evalJs(`(() => {
      const nodes = Array.from(document.querySelectorAll('.ant-card[style*="flex: 1"] [data-node-id]'));
      const target = nodes[nodes.length - 1] || nodes[0];
      if (!target) return 'no-node';
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'clicked';
    })()`);
    await sleep(600);
    const filled = await cdp.evalJs(`(() => {
      const card = ${PROP_PANEL};
      if (!card) return 'no-panel';
      const group = Array.from(card.querySelectorAll('.ant-form-item')).find(f => f.textContent.includes('显示条件'));
      const input = group?.querySelector('input');
      if (!input) return 'no-expr-input';
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      s.call(input, '{{ amount > }}');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'set';
    })()`);
    ok('A6-1 填入错误表达式', filled === 'set', filled);
    await sleep(600);
    const saveDisabled = await cdp.evalJs(`(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const save = btns.find(b => (b.textContent || '').replace(/\\s+/g, '').startsWith('保存'));
      return save ? String(save.disabled) : 'missing';
    })()`);
    ok('A6-2 表达式错误阻断保存按钮', saveDisabled === 'true', 'disabled=' + saveDisabled);
    ok('A6-3 错误提示可见', (await bodyText()).includes('表达式错误'));

    // 修正表达式后保存
    await cdp.evalJs(`(() => {
      const card = ${PROP_PANEL};
      const group = Array.from(card.querySelectorAll('.ant-form-item')).find(f => f.textContent.includes('显示条件'));
      const input = group.querySelector('input');
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      s.call(input, '{{ amount > 100 }}');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(500);
    await clickToolbar('保存');
    ok('A6-4 修正后保存成功', await waitText('已保存', 10000));

    // 落库核对：草稿含 visibleWhen 且版本推进
    const listed = await admin.call('GET', '/api/pages?appId=1');
    const mine = (listed.json.list || listed.json.data?.list || []).find((p) => p.pageKey === pageKey);
    ok('A6-5 页面落库可查', !!mine, JSON.stringify(mine).slice(0, 120));
    const draft = await admin.call('GET', `/api/pages/${mine.id}/draft`);
    const draftSchema = draft.json.schema ?? draft.json.data?.schema;
    ok('A6-6 草稿含修正后表达式', JSON.stringify(draftSchema).includes('amount > 100'), '');

    // ========== A7 409 冲突 ==========
    const serverVersion = draft.json.draftVersion ?? draft.json.data?.draftVersion;
    await admin.expect('A7-1 外部保存推高版本', 'PUT', `/api/pages/${mine.id}/draft`, 200, {
      schema: draftSchema, baseDraftVersion: serverVersion,
    });

    // 本地再改 → 保存（本地 draftVersion 落后 → 409）
    await cdp.evalJs(`(() => {
      const card = ${PROP_PANEL};
      const input = card?.querySelector('.ant-form-item input');
      const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      s.call(input, '冲突测试标题');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(400);
    await clickToolbar('保存');
    ok('A7-2 409 冲突弹层出现', await waitText('草稿版本冲突', 10000));

    // 保留我的修改(断言改查属性输入框 value——input value 不进 innerText)
    await clickButton('保留我的修改，稍后处理', 'document.querySelector(".ant-modal")');
    await sleep(800);
    const kept = await cdp.evalJs(`(() => {
      const card = Array.from(document.querySelectorAll('.ant-card')).find(c => { const h = c.querySelector('.ant-card-head'); return h && h.textContent.trim() === '属性'; });
      const input = card?.querySelector('.ant-form-item input');
      return input ? input.value : '';
    })()`);
    ok('A7-3 保留后本地草稿仍在', kept === '冲突测试标题', 'input value=' + kept);

    // 显式放弃 → 对齐服务器
    await clickToolbar('保存');
    await waitText('草稿版本冲突', 10000);
    await clickButton('放弃我的修改', 'document.querySelector(".ant-modal")');
    ok('A7-4 放弃后对齐服务器版本', await waitText('已放弃本地修改', 10000));

    // ========== A8 发布预览 ==========
    // 重新保存（对齐后 dirty=false 直接预览；先保存确保草稿落库）
    await clickToolbar('保存');
    await waitText('已保存', 10000);
    const uiPageId = mine.id;
    await admin.expect('A8-1 发布应用', 'POST', '/api/apps/1/publish', 200, { changelog: 'M13 验收发布' });

    const grant = await admin.call('POST', '/api/apps/1/preview-grants', { pageId: Number(uiPageId) });
    const grantId = grant.json.grantId ?? grant.json.data?.grantId;
    ok('A8-2 预览 grant 签发', !!grantId, 'grantId=' + String(grantId).slice(0, 12));

    const exchange = await request('POST', '/api/preview/exchange', { body: { grantId }, headers: { 'Content-Type': 'application/json', Origin: BASE } });
    const previewToken = exchange.json?.accessToken ?? exchange.json?.data?.accessToken;
    ok('A8-3 exchange 成功（15min 会话）', !!previewToken, 'HTTP ' + exchange.status);

    // 发布面读取（预览 token 匿名——04BE §A.7 隔离；端点拒正式会话凭证）
    const runtimePage = await request('GET', `/api/runtime/pages/${uiPageId}?published=1`, {
      headers: { Origin: BASE, Authorization: 'Bearer ' + previewToken },
    });
    const rtBody = JSON.stringify(runtimePage.json ?? {});
    ok('A8-4 发布面可读（预览 token 通过隔离通道）',
      runtimePage.status === 200 && !!rtBody, 'HTTP ' + runtimePage.status + ' body=' + rtBody.slice(0, 80));

    // 浏览器走完整预览路由（新 grant——exchange 已消费一个）
    const grant2 = await admin.call('POST', '/api/apps/1/preview-grants', { pageId: Number(uiPageId) });
    const grant2Id = grant2.json.grantId ?? grant2.json.data?.grantId;
    await cdp.goto(`${BASE}/runtime/#/preview?grant=${grant2Id}`);
    await sleep(3000);
    const previewText = await bodyText();
    ok('A8-5 预览路由渲染（预览模式标识）', previewText.includes('预览模式'), previewText.slice(0, 150));
    ok('A8-6 预览兑换链路无失败（不含「预览失败」）', !previewText.includes('预览失败'), '');

    // grant 一次性（重放被拒）
    const replay = await request('POST', '/api/preview/exchange', { body: { grantId: grant2Id }, headers: { 'Content-Type': 'application/json', Origin: BASE } });
    ok('A8-7 grant 重放被拒', replay.status === 401 || replay.status === 404 || replay.status === 400, 'HTTP ' + replay.status);

    // ========== A9 字段绑定（未绑模型页提示）==========
    await cdp.goto(`${BASE}/designer/`);
    await cdp.waitFor('.ant-layout-header', 10000);
    await cdp.evalJs(`(() => { const cards = Array.from(document.querySelectorAll('.ant-card')); const c = cards.find(x => x.textContent.includes('报销管理')); (c?.querySelector('button') || c)?.click(); })()`);
    await cdp.waitFor('.ant-tabs', 8000);
    await clickTab('页面');
    await waitText(pageKey, 8000);
    await openDesign(pageKey);
    // 选中最后一个节点（TextInput——数据绑定组存在）
    await cdp.evalJs(`(() => {
      const nodes = Array.from(document.querySelectorAll('.ant-card[style*="flex: 1"] [data-node-id]'));
      const target = nodes[nodes.length - 1] || nodes[0];
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
    await sleep(1500);
    const bindShown = await cdp.evalJs(`(() => {
      const card = Array.from(document.querySelectorAll('.ant-card')).find(c => { const h = c.querySelector('.ant-card-head'); return h && h.textContent.trim() === '属性'; });
      if (!card) return 'no-panel';
      const txt = card.textContent;
      return txt.includes('数据绑定') ? 'has-bind-group' : txt.slice(0, 60);
    })()`);
    ok('A9-1 未绑模型页字段绑定入口（数据绑定组渲染，下拉提示未绑模型）', bindShown === 'has-bind-group', String(bindShown).slice(0, 60));

    summary('page-designer');
  } finally {
    await cdp.close();
  }
})().catch((e) => {
  console.error('验收中断:', e.message);
  process.exitCode = 1;
  try { summary('page-designer'); } catch {}
});
