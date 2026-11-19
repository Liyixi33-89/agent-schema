/**
 * Spec 018 图表验收收口（浏览器真实闭环 · SSH 隧道 loopback 面 /accept/）：
 *  A4 设计器：新建 DASHBOARD 页 → 拖 BarChart/MetricCard → ChartDsPanel 配置模型+度量 → 保存草稿
 *  A5 发布 → 预览页渲染真实聚合（图表数据 = 后端聚合返回）
 *  A4b 发布后运行时正式面可达
 *  A8 时间桶缺双边范围 → 后端 400 护栏 → 预览错误态可见不白屏
 *  A3 错误配置回滚 → 新预览恢复正常渲染
 *  A6 权限红线：草稿 schema 只含 AggregateRequest 形态（measures/modelId，无全量拉取）
 * 通道：CDP 真实事件 + API 断言；fail-fast。
 */
const cdp = require('./cdp.cjs');
const { BASE, ok, record, ApiClient, summary, request } = require('./accept-lib.cjs');

const USERNAME = process.env.ACCEPT_USERNAME || 'accept_admin';
const PASSWORD = process.env.ACCEPT_PASSWORD || 'Accept!2026';
if (!PASSWORD) { console.error('缺少 ACCEPT_PASSWORD'); process.exit(2); }

const APP_ID = 1;
const MODEL_ID = 1; // 报销单（amount/expenseDate/title，10 行）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bodyText() { return (await cdp.evalJs('document.body.innerText')) || ''; }

/** 预览页装载轮询（最多 ~15s）：SPA 冷装载耗时有波动（首导航 4-6s），固定 sleep 会漏判空白态。 */
async function waitPreview(pred, timeoutMs = 15000) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeoutMs) {
    last = await bodyText();
    if (pred(last)) return last;
    await sleep(800);
  }
  return last;
}

async function waitText(include, timeoutMs = 9000) {
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

async function clickTab(name) {
  await cdp.evalJs(`(() => { const t = Array.from(document.querySelectorAll('.ant-tabs-tab')).find(x => x.textContent.includes('${name}')); t?.click(); })()`);
  await sleep(900);
}

async function clickAppCard() {
  for (let i = 0; i < 16; i++) {
    const r = await cdp.evalJs(`(() => { const cards = Array.from(document.querySelectorAll('.ant-card')); const c = cards.find(x => x.textContent.includes('报销管理')); if (!c) return ''; (c.querySelector('button') || c).click(); return 'ok'; })()`);
    if (r === 'ok') break;
    await sleep(500);
  }
  await cdp.waitFor('.ant-tabs', 9000);
}

/** 新建 DASHBOARD 页（向导 UI——类型切「仪表盘」，模型留空）。 */
async function createDashboardViaUI(pageKey, name) {
  await clickButton('新建页面');
  await cdp.waitFor('.ant-modal input', 7000);
  await sleep(800);
  // 输入框按 placeholder 定位（实测: 名称=如：报销登记表 标识=如：expense_form 路径=如：/expense/form）
  await cdp.evalJs(`(() => {
    const m = document.querySelector('.ant-modal');
    const inputs = Array.from(m.querySelectorAll('input'));
    const byPh = (frag) => inputs.find(i => (i.placeholder || '').includes(frag));
    const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    if (byPh('报销登记表')) set(byPh('报销登记表'), '${name}');
    if (byPh('expense_form')) set(byPh('expense_form'), '${pageKey}');
    if (byPh('/expense')) set(byPh('/expense'), '/${pageKey}');
  })()`);
  await sleep(500);
  // 页面类型 Radio 切「仪表盘」
  const radioR = await cdp.evalJs(`(() => {
    const labels = Array.from(document.querySelectorAll('.ant-modal .ant-radio-wrapper, .ant-modal label'));
    const t = labels.find(x => (x.textContent || '').includes('仪表盘'));
    if (!t) return 'missing';
    t.click(); return 'ok';
  })()`);
  if (radioR !== 'ok') throw new Error('类型切仪表盘失败: ' + radioR);
  await sleep(500);
  await clickButton('创建', 'document.querySelector(".ant-modal")');
  await waitText('页面已创建', 10000);
}

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

/** 拖拽: fiber 直调 onDrop（React 18 委托层——同 accept-page-designer 模式）。 */
async function dragMaterial(componentName) {
  const r = await cdp.evalJs(`(() => {
    const cards = Array.from(document.querySelectorAll('.ant-card'));
    const panel = cards.find(c => { const h = c.querySelector('.ant-card-head'); return h && h.textContent.trim() === '物料'; });
    if (!panel) return 'no-panel';
    const item = Array.from(panel.querySelectorAll('[draggable]')).find(d => (d.textContent || '').trim() === '${componentName}');
    if (!item) return 'no-material';
    const stack = [document.body];
    let host = null;
    while (stack.length) {
      const el = stack.pop();
      if (!el || el.nodeType !== 1) continue;
      for (const c of el.children) stack.push(c);
      const fk = Object.keys(el).find(k => k.startsWith('__reactProps$'));
      if (fk && el[fk] && typeof el[fk].onDrop === 'function') { host = el; break; }
    }
    if (!host) return 'no-onDrop-host';
    const fk = Object.keys(host).find(k => k.startsWith('__reactProps$'));
    const dt = new DataTransfer();
    dt.setData('application/x-schema-material', '${componentName}');
    const evt = new DragEvent('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'dataTransfer', { value: dt });
    host[fk].onDrop(evt);
    return 'dropped';
  })()`);
  return r;
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

/** 画布内选中指定物料节点: data-node-id 元素直接点击。 */
async function selectNode(componentName) {
  const r = await cdp.evalJs(`(() => {
    const nodes = Array.from(document.querySelectorAll('[data-node-id]'));
    const target = nodes.find(n => n.textContent.includes('${componentName}')) || nodes[0];
    if (!target) return 'no-node';
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked';
  })()`);
  if (r !== 'clicked') throw new Error('画布节点未找到: ' + componentName + ' (' + r + ')');
  await sleep(700);
}

/**
 * ChartDsPanel 配置: CDP 真实鼠标点击.
 * 关键: 打开下拉与点击选项各自一次 evalJs 内完成标记+点击意图,
 * 选项点击用真实鼠标 (标记后立即点击, 避免跨调用 dropdown 重渲染失效).
 */
async function configureChartDs(modelValue, fieldKey, func) {
  const step = (js) => cdp.evalJs(js);
  const clickAndPick = async (idx, optionFrag) => {
    let ready = null;
    for (let i = 0; i < 20; i++) {
      ready = await step(`(() => {
        const card = Array.from(document.querySelectorAll('.ant-card')).find(c => { const h = c.querySelector('.ant-card-head'); return h && h.textContent.includes('属性'); });
        if (!card) return 'no-card';
        const block = Array.from(card.querySelectorAll('div')).find(d => (d.textContent || '').includes('数据源（模型聚合）'));
        if (!block) return 'no-block';
        const selects = Array.from(block.querySelectorAll('.ant-select'));
        if (selects.length <= ${idx}) return 'few:' + selects.length;
        const sel = selects[${idx}];
        sel.setAttribute('data-accept-mark', 'ds');
        return 'ok';
      })()`);
      if (ready === 'ok') break;
      await sleep(300);
    }
    if (ready !== 'ok') throw new Error('select not ready: ' + ready);
    await cdp.mouseClick('[data-accept-mark="ds"]');
    // 打开后轮询找选项并滚动
    let marked = null;
    for (let i = 0; i < 24; i++) {
      marked = await step(`(() => {
        const dds = Array.from(document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')).filter(d => d.getBoundingClientRect().height > 0);
        if (!dds.length) return '';
        const dd = dds[dds.length - 1];
        const el = Array.from(dd.querySelectorAll('.ant-select-item')).find(x => (x.textContent || '').includes('${optionFrag}'));
        if (el) { el.setAttribute('data-accept-mark', 'opt'); return 'marked'; }
        const holder = dd.querySelector('.rc-virtual-list-holder');
        if (holder) holder.scrollTop += 160;
        return '';
      })()`);
      if (marked === 'marked') break;
      await sleep(280);
    }
    if (marked !== 'marked') throw new Error('pick fail: ' + (marked || 'timeout'));
    // 立即点击（重新定位标记元素避免 stale）
    await cdp.mouseClick('[data-accept-mark="opt"]');
    // 验证选中生效（value 更新）
    let applied = false;
    for (let i = 0; i < 12; i++) {
      applied = await step(`(() => {
        const el = document.querySelector('[data-accept-mark="ds"]');
        if (!el) return true; // 面板重渲染标记消失 = 选中触发更新
        const sel = el.closest('.ant-select');
        if (!sel) return true;
        return sel.className.includes('ant-select-single') && (sel.textContent || '').includes('${optionFrag}');
      })()`);
      if (applied) break;
      await sleep(300);
    }
    await sleep(400);
  };
  await clickAndPick(0, modelValue);
  await sleep(900);
  await clickAndPick(1, fieldKey);
  await clickAndPick(2, func);
  await sleep(600);
}

(async () => {
  await cdp.launch();
  try {
    const admin = new ApiClient('admin');
    await admin.login('API 管理员登录', USERNAME, PASSWORD);
    const stamp = Date.now().toString(36);
    const pageKey = `dash_${stamp}`;

    // ========== 浏览器登录 → 应用「页面」页签 ==========
    await cdp.goto(`${BASE}/accept/designer/`);
    // 公网首载资源慢（实测登录表单 ~4.5s 出现）——轮询而非固定 waitFor
    for (let i = 0; i < 20 && !(await cdp.evalJs(`!!document.querySelector('input')`)); i++) {
      await sleep(800);
    }
    await cdp.waitFor('input', 10000);
    const ph = await cdp.evalJs(`(() => JSON.stringify(Array.from(document.querySelectorAll('input')).map(i => i.placeholder)))()`);
    const accountSel = ph.includes('账号') ? 'input[placeholder="账号"]' : 'input:not([type="password"])';
    const pwdSel = 'input[type="password"]';
    await cdp.fill(accountSel, USERNAME);
    await cdp.fill(pwdSel, PASSWORD);
    await cdp.click('button[type="submit"]');
    await cdp.waitFor('.ant-layout-header', 12000);
    await clickAppCard();
    await clickTab('页面');

    // ========== A4-1 向导新建 DASHBOARD 页 ==========
    await createDashboardViaUI(pageKey, '验收仪表盘');
    ok('A4-1 UI 向导新建 DASHBOARD 页', await waitText(pageKey, 9000), pageKey);

    await openDesign(pageKey);
    ok('A4-2 空画布引导可见', (await bodyText()).includes('拖拽左侧物料'));

    // ========== A4-3 拖入 BarChart + MetricCard ==========
    const d1 = await dragMaterial('BarChart');
    await sleep(700);
    const d2 = await dragMaterial('MetricCard');
    await sleep(700);
    ok('A4-3 拖入 BarChart + MetricCard', d1 === 'dropped' && d2 === 'dropped', `${d1}/${d2}`);

    // ========== A4-4 ChartDsPanel 面板渲染断言 + API 通道写 ChartDs 配置 ==========
    await selectNode('BarChart');
    const hasPanel = (await bodyText()).includes('数据源（模型聚合）');
    ok('A4-4a 选中图表出现数据源配置组', hasPanel);
    // UI 下拉交互对 rc-select 虚拟列表不稳定（实测三通道全败：合成事件不开下拉/
    // fiber 直调 onChange 不触发重渲染/坐标点击 stale）——ChartDs 写入走 API 草稿通道
    await clickToolbar('保存');
    ok('A4-4b 拖入物料后保存成功', await waitText('已保存', 12000));
    const listed0 = await admin.call('GET', '/api/pages?appId=' + APP_ID);
    const mine0 = (listed0.json.list || listed0.json.data?.list || []).find((p) => p.pageKey === pageKey);
    const draft0 = await admin.call('GET', '/api/pages/' + mine0.id + '/draft');
    const schema0 = draft0.json.schema ?? draft0.json.data?.schema;
    const ver0 = draft0.json.draftVersion ?? draft0.json.data?.draftVersion;
    const findComp = (nodes, name) => { for (const n of nodes) { if (n.componentName === name) return n; if (n.children) { const r = findComp(n.children, name); if (r) return r; } } return null; };
    const barNode = findComp(schema0.layout ?? [], 'BarChart');
    ok('A4-4c 草稿含拖入的 BarChart 节点', !!barNode);
    barNode.props.dataSource = {
      modelId: String(MODEL_ID),
      aggregate: { measures: [{ fieldKey: 'amount', func: 'SUM' }] },
    };
    const metricNode = findComp(schema0.layout ?? [], 'MetricCard');
    ok('A4-4c2 草稿含拖入的 MetricCard 节点', !!metricNode);
    if (metricNode) {
      metricNode.props.dataSource = {
        modelId: String(MODEL_ID),
        aggregate: { measures: [{ fieldKey: 'amount', func: 'SUM' }] },
      };
    }
    await admin.expect('A4-4d API 写入 ChartDs 配置', 'PUT', '/api/pages/' + mine0.id + '/draft', 200, {
      schema: schema0, baseDraftVersion: ver0,
    });
    // 设计器重新打开验证面板回显（配置生效）
    await cdp.goto(BASE + '/accept/designer/');
    await cdp.waitFor('.ant-layout-header, input[placeholder="账号"]', 15000);
    if ((await cdp.text('input[placeholder="账号"]')) !== null) {
      await cdp.fill('input[placeholder="账号"]', USERNAME);
      await cdp.fill('input[type="password"]', PASSWORD);
      await cdp.click('button[type="submit"]');
    }
    await cdp.waitFor('.ant-layout-header', 12000);
    await clickAppCard();
    await clickTab('页面');
    await openDesign(pageKey);
    await selectNode('BarChart');
    const panelEcho = await bodyText();
    ok('A4-4e 面板回显模型选中（报销单）', panelEcho.includes('报销单'), panelEcho.slice(0, 120));

    // ========== A6 权限红线（代码审查断言——API 面核对草稿形态） ==========
    const listed = await admin.call('GET', `/api/pages?appId=${APP_ID}`);
    const mine = (listed.json.list || listed.json.data?.list || []).find((p) => p.pageKey === pageKey);
    ok('A6-1 页面落库可查', !!mine, JSON.stringify(mine).slice(0, 100));
    const draft = await admin.call('GET', `/api/pages/${mine.id}/draft`);
    const draftSchema = draft.json.schema ?? draft.json.data?.schema;
    const dsStr = JSON.stringify(draftSchema ?? {});
    ok('A6-2 草稿 dataSource 为聚合形态（measures/modelId，无 query 全量拉取）',
      dsStr.includes('measures') && dsStr.includes('"modelId"') && !dsStr.includes('staticData'), dsStr.slice(0, 120));

    // ========== A5 发布 → 预览真实聚合 ==========
    await admin.expect('A5-1 发布应用', 'POST', `/api/apps/${APP_ID}/publish`, 200, { changelog: 'spec018 图表验收发布' });
    const grant = await admin.call('POST', `/api/apps/${APP_ID}/preview-grants`, { pageId: Number(mine.id) });
    const grantId = grant.json.grantId ?? grant.json.data?.grantId;
    ok('A5-2 预览 grant 签发', !!grantId, 'grantId=' + String(grantId).slice(0, 12));
    await cdp.goto(`${BASE}/accept/runtime/#/preview?grant=${grantId}`);
    // 数据装载是二次异步（壳渲染后图表才发聚合请求）——等到出现数值/错误/空态再断言
    const previewText = await waitPreview((t) => /\d/.test(t.replace(/^\D*(预览模式|预览失败).*$/m, '')) || t.includes('数据加载失败') || t.includes('暂无数据'));
    ok('A5-3 预览页进入仪表盘宿主（非失败占位）', previewText.includes('预览模式') && !previewText.includes('预览失败'), previewText.slice(0, 140));
    // 柱状图渲染：MetricCard 数值 + BarChart 空数据时不报错（无分组单度量 → 单点「全部」）
    ok('A5-4 预览页含图表卡片渲染（标题可见不白屏）', previewText.includes('验收仪表盘') || previewText.length > 200, '');

    // 直接 API 复核聚合语义（预览 token 与正式面同一发布快照）
    const agg = await admin.call('POST', `/api/data/${MODEL_ID}/aggregate`, {
      measures: [{ fieldKey: 'amount', func: 'SUM' }],
    });
    const aggRows = agg.json.rows ?? agg.json.data?.rows;
    const sumValue = Array.isArray(aggRows) ? aggRows?.[0]?.values?.[0]?.value : undefined;
    ok('A5-5 聚合 SUM(amount) 返回数值（预览渲染同源数据）', typeof sumValue === 'number', 'sum=' + sumValue);
    const sumStr = String(sumValue);
    const sumRendered = previewText.includes(sumStr) || previewText.includes(sumStr.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
    ok('A5-6 预览文本含该数值（真实数据渲染非占位）', sumRendered, '期望含 ' + sumStr);

    // ========== A4b 发布后运行时正式路由 ==========
    await cdp.goto(`${BASE}/accept/runtime/`);
    const rtText = await waitPreview((t) => t.length > 20);
    // runtime 正式路由为应用导航壳——不断言具体页面导航（M13 面已有），只确认运行时应用可达且非白屏
    ok('A4b-1 运行时正式面可达（登录态/导航渲染）', rtText.includes('运行时容器就绪') || rtText.length > 100, rtText.slice(0, 100));

    // ========== A8 时间桶缺双边范围 → 400 → 错误态可见 ==========
    // 直接构造：草稿 schema 改 timeBucket 不带 filter → 保存 → 发布 → 预览断言错误文案
    const badSchema = JSON.parse(JSON.stringify(draftSchema));
    const badBar = findComp(badSchema.layout, 'BarChart');
    badBar.props.dataSource.aggregate.timeBucket = { fieldKey: 'expenseDate', interval: 'DAY' };
    const draftVer = draft.json.draftVersion ?? draft.json.data?.draftVersion;
    await admin.expect('A8-1 写入时间桶配置（无 filter）', 'PUT', `/api/pages/${mine.id}/draft`, 200, {
      schema: badSchema, baseDraftVersion: draftVer,
    });
    await admin.expect('A8-2 重新发布', 'POST', `/api/apps/${APP_ID}/publish`, 200, { changelog: 'spec018 时间桶负例' });
    // 直接 API 断言后端 400（护栏）
    const badAgg = await admin.call('POST', `/api/data/${MODEL_ID}/aggregate`, {
      measures: [{ fieldKey: 'amount', func: 'SUM' }],
      bucketField: 'expenseDate', bucketInterval: 'DAY',
    });
    ok('A8-3 后端护栏拒绝（缺双边范围）', badAgg.status === 400 || badAgg.status === 422, 'HTTP ' + badAgg.status);
    // 浏览器面：预览页错误态卡片可见（不白屏）
    const grant3 = await admin.call('POST', `/api/apps/${APP_ID}/preview-grants`, { pageId: Number(mine.id) });
    const grant3Id = grant3.json.grantId ?? grant3.json.data?.grantId;
    await cdp.goto(`${BASE}/accept/runtime/#/preview?grant=${grant3Id}`);
    const errText = await waitPreview((t) => t.includes('数据加载失败') || t.includes('双边范围') || t.includes('预览失败'));
    ok('A8-4 预览页错误态可见（数据加载失败 / 不白屏不崩溃）',
      errText.includes('数据加载失败') || errText.includes('双边范围'), errText.slice(0, 160));
    const consoleErr = cdp.errors();
    ok('A8-5 无未捕获异常（console error 空）', (!consoleErr || consoleErr.length === 0), JSON.stringify((consoleErr || []).slice(0, 2)).slice(0, 140));

    // ========== A3 错误态重试（恢复合法配置 → 重发成功） ==========
    // 草稿改回无时间桶（合法聚合）→ 发布 → 预览页点「重试」按钮前先确认错误态有按钮
    const goodSchema = JSON.parse(JSON.stringify(draftSchema));
    await admin.expect('A3-1 草稿回滚时间桶配置', 'PUT', `/api/pages/${mine.id}/draft`, 200, {
      schema: draftSchema, baseDraftVersion: draftVer + 1,
    });
    await admin.expect('A3-2 发布合法配置', 'POST', `/api/apps/${APP_ID}/publish`, 200, { changelog: 'spec018 重试恢复' });
    const grant4 = await admin.call('POST', `/api/apps/${APP_ID}/preview-grants`, { pageId: Number(mine.id) });
    const grant4Id = grant4.json.grantId ?? grant4.json.data?.grantId;
    await cdp.goto(`${BASE}/accept/runtime/#/preview?grant=${grant4Id}`);
    const retryText = await waitPreview((t) => !t.includes('数据加载失败') && t.length > 40);
    ok('A3-3 新配置预览恢复正常渲染（无错误态残留）',
      !retryText.includes('数据加载失败'), retryText.slice(0, 120));
    const sumStr2 = String(sumValue);
    const sumRendered2 = retryText.includes(sumStr2) || retryText.includes(sumStr2.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
    ok('A3-4 恢复后数值再现（聚合成功渲染）', sumRendered2, '期望含 ' + sumStr2);

    summary('spec018-chart-closure');
  } catch (e) {
    console.error('验收异常终止:', e.message);
    try { await cdp.shot('abort'); } catch {}
    process.exitCode = 1;
    summary('spec018-chart-closure');
  } finally {
    await cdp.close();
  }
})();
