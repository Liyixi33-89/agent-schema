/**
 * M12 浏览器验收：ER 建模器全链（建模→两段式保存→版本回滚）【重建版】
 * 双通道：浏览器 UI（CDP 真实事件）+ API 断言 + DB 落库核对；fail-fast。
 *
 * CDP 交互要点（调试沉淀）：
 * - antd Select 必须点击内部 input（CDP Input 域）才能展开下拉
 * - antd 双字按钮渲染为「应 用」（中间空格）——文本匹配须做空白归一
 * - 模板字符串中 \s 会被求值为 s（吞杠）——正则须写 \\s
 * - fiber 直调 onClick 可绕过 disabled——保存按钮禁用态须显式断言
 * - 画布含历史模型卡片——按钮定位必须按模型卡片 scope
 * - React Flow 画布（M12 基线对齐后）：节点 = .react-flow__node[data-id]，
 *   卡片内容在 .er-node 内；选中态节点带 selected class
 */
const cdp = require('./cdp.cjs');
const { BASE, ok, record, ApiClient, dbQuery, summary } = require('./accept-lib.cjs');

/** fiber key 前缀（模板字符串内 $ 会触发插值，先在 Node 侧算好传入）。 */
const FIBER_KEY = '__reactFiber$';

async function waitText(include, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const body = await cdp.evalJs('document.body.innerText');
    if (body && body.includes(include)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function clickTab(name) {
  await cdp.evalJs(`(() => { const t = Array.from(document.querySelectorAll('.ant-tabs-tab')).find(x => x.textContent.includes('${name}')); t?.click(); })()`);
  await new Promise((r) => setTimeout(r, 800));
}

/** 按文本找按钮并原生 el.click()（React 18 合成事件链完整支持——fiber 直调假事件对 async handler 不可靠）。 */
const clickByText = (scope, text) => cdp.evalJs(`(() => {
  const norm = (s) => (s || '').replace(/[\\s\u3000]+/g, '');
  const el = Array.from((${scope} || document).querySelectorAll('button')).find(x => norm(x.textContent).includes(norm('${text}')));
  if (!el) return 'missing';
  el.click();
  return 'clicked';
})()`).then((r) => {
  if (r === 'missing') throw new Error('按钮未找到: ' + text);
  return r;
});

/** 等抽屉动画完成（enter 期间坐标漂移会让 mouseClick 落空）。 */
async function waitDrawerAnim() {
  await cdp.evalJs(`(() => new Promise((res) => { const d = document.querySelector('.ant-drawer'); const done = () => res('done'); if (!d) return done(); d.addEventListener('transitionend', done, { once: true }); setTimeout(done, 1600); }))()`);
}

(async () => {
  await cdp.launch();
  const stamp = Date.now().toString(36);
  let modelId = null;
  try {
    // ---------- 0. API 契约：模型创建与列表（01BE §A.1） ----------
    const admin = new ApiClient('admin');
    await admin.login('API 管理员登录', 'accept_admin', process.env.ACCEPT_PASSWORD || 'Accept!2026');
    const mk = `er_accept_${stamp}`;
    const created = await admin.expect('API 新建模型', 'POST', '/api/models', 200,
      { modelKey: mk, name: `验收模型${stamp}` }, { 'X-App-Id': '1' });
    modelId = created.json?.id;
    ok('新建模型返回 id 与 v1', typeof modelId === 'string' && created.json?.currentVersion === 1,
      `id=${modelId} v=${created.json?.currentVersion}`);
    const detail = await admin.expect('API 模型详情空字段', 'GET', `/api/models/${modelId}`, 200, null,
      { 'X-App-Id': '1' });
    ok('详情字段数组为空', Array.isArray(detail.json?.fields) && detail.json.fields.length === 0,
      JSON.stringify(detail.json?.fields));
    const dbModel = dbQuery(`SELECT model_key, current_version FROM meta_model WHERE id = ${modelId}`);
    ok('模型落库 v1', dbModel.length === 1 && dbModel[0].includes(mk) && dbModel[0].includes('1'),
      JSON.stringify(dbModel));

    // ---------- 1. UI 登录与画布 ----------
    await cdp.goto(`${BASE}/designer/`);
    await cdp.waitFor('input[placeholder="账号"]', 10000);
    await cdp.fill('input[placeholder="账号"]', 'accept_admin');
    await cdp.fill('input[placeholder="密码"]', process.env.ACCEPT_PASSWORD || 'Accept!2026');
    await cdp.click('button[type="submit"]');
    await cdp.waitFor('.ant-layout-header', 10000);
    ok('登录进入工作台', await waitText('新建应用', 8000));

    // 进入应用 1 设置 → 模型页签
    await cdp.evalJs(`(() => { const cards = Array.from(document.querySelectorAll('.ant-card')); const c = cards.find(x => x.textContent.includes('报销管理')); (c?.querySelector('button') || c)?.click(); })()`);
    await cdp.waitFor('.ant-tabs', 8000);
    await clickTab('模型');
    ok('「模型」页签就绪', await waitText('新建模型', 6000));
    ok('画布展示新建模型卡片', await waitText(`验收模型${stamp}`, 6000));
    // React Flow 基线断言（10FE §1.2 画布）：视口/节点/缩放控件真实渲染
    await cdp.waitFor('.react-flow__renderer', 8000);
    const flowState = await cdp.evalJs(`(() => JSON.stringify({
      viewport: !!document.querySelector('.react-flow__viewport'),
      nodes: document.querySelectorAll('.react-flow__node').length,
      zoom: !!document.querySelector('.react-flow__controls'),
      minimap: !!document.querySelector('.react-flow__minimap'),
      pane: !!document.querySelector('.react-flow__pane'),
    }))()`);
    const fs1 = JSON.parse(flowState);
    ok('React Flow 画布渲染（viewport/controls/minimap）',
      fs1.viewport && fs1.nodes >= 1 && fs1.zoom && fs1.minimap, flowState);
    await cdp.shot('er-canvas');

    // ---------- 2. 字段抽屉：新增字段（UI 操作生成 ADD_FIELD） ----------
    await clickByText(`document`, '编辑字段');
    await cdp.waitFor('.ant-drawer', 5000);
    ok('抽屉打开', true);
    await clickByText(`document.querySelector('.ant-drawer')`, '新增字段');
    await cdp.waitFor('.ant-drawer input#fieldKey', 5000);
    await cdp.fill('.ant-drawer input#fieldKey', 'amount');
    await waitDrawerAnim();
    // antd Select：点击内部 input 展开（CDP Input 域）
    await cdp.mouseClick('.ant-drawer input#type');
    await new Promise((r) => setTimeout(r, 800));
    const optionPick = await cdp.evalJs(`(() => JSON.stringify(Array.from(document.querySelectorAll('.ant-select-dropdown .ant-select-item')).map(o => o.getAttribute('title'))))()`);
    const optionList = JSON.parse(optionPick || '[]');
    if (!optionList.includes('number')) throw new Error('类型下拉缺少 number 选项: ' + optionPick);
    await cdp.mouseClick(`.ant-select-dropdown .ant-select-item[title="number"]`);
    await new Promise((r) => setTimeout(r, 500));
    await cdp.fill('.ant-drawer input#label', '金额');
    await new Promise((r) => setTimeout(r, 400));
    await clickByText(`document.querySelector('.ant-drawer .ant-drawer-body')`, '应用');
    await new Promise((r) => setTimeout(r, 800));
    ok('抽屉新增字段入草稿', await waitText('amount', 5000));
    await cdp.shot('er-drawer-add');

    // ---------- 3. 两段式保存 INFO 档（新增无风险） ----------
    await clickByText(`document`, '保存变更');
    await cdp.waitFor('.ant-modal', 6000);
    const modalText = await cdp.text('.ant-modal');
    ok('确认弹层含变更清单与影响面', modalText?.includes('变更清单') && modalText?.includes('影响面')
      && modalText?.includes('新增') && modalText?.includes('amount'), (modalText ?? '').slice(0, 160));
    await clickByText(`document.querySelector('.ant-modal')`, '确认保存');
    await new Promise((r) => setTimeout(r, 900));
    ok('INFO 档一键保存成功提示', await waitText('已保存（v2）', 6000));
    const dbV2 = dbQuery(`SELECT current_version FROM meta_model WHERE id = ${modelId}`);
    ok('保存后落库 v2', dbV2[0]?.startsWith('2'), JSON.stringify(dbV2));
    const dbField = dbQuery(`SELECT field_key, field_type, field_status FROM meta_field WHERE model_id = ${modelId} AND field_key = 'amount'`);
    ok('字段 amount 落库（number/ACTIVE）', dbField.length === 1 && dbField[0].includes('amount') && dbField[0].includes('number') && dbField[0].includes('ACTIVE'),
      JSON.stringify(dbField));
    await cdp.shot('er-saved-info');

    // ---------- 4. confirmToken 一次性（API 重放拒绝） ----------
    const pre = await admin.call('POST', `/api/models/${modelId}/precheck`,
      { changes: [{ op: 'MODIFY_FIELD', fieldKey: 'amount', patch: { label: '金额改' } }] },
      { 'X-App-Id': '1' });
    ok('API precheck 签发 token（INFO）', pre.status === 200 && typeof pre.json?.confirmToken === 'string'
      && pre.json?.confirmMode === 'INFO', `mode=${pre.json?.confirmMode}`);
    const save1 = await admin.call('POST', `/api/models/${modelId}/schema`,
      { changes: [{ op: 'MODIFY_FIELD', fieldKey: 'amount', patch: { label: '金额改' } }],
        baseVersion: 2, confirmToken: pre.json.confirmToken }, { 'X-App-Id': '1' });
    ok('首次保存成功 v3', save1.status === 200 && save1.json?.version === 3, `HTTP ${save1.status} body=${save1.raw.slice(0, 120)}`);
    const save2 = await admin.call('POST', `/api/models/${modelId}/schema`,
      { changes: [{ op: 'MODIFY_FIELD', fieldKey: 'amount', patch: { label: '金额改' } }],
        baseVersion: 3, confirmToken: pre.json.confirmToken }, { 'X-App-Id': '1' });
    ok('token 重放被拒 422', save2.status === 422 && save2.json?.code === 'CONFIRM_TOKEN_INVALID',
      `HTTP ${save2.status} code=${save2.json?.code}`);

    // ---------- 5. 409 版本冲突（旧 baseVersion） ----------
    const pre2 = await admin.call('POST', `/api/models/${modelId}/precheck`,
      { changes: [{ op: 'MODIFY_FIELD', fieldKey: 'amount', patch: { label: '冲突测试' } }] }, { 'X-App-Id': '1' });
    const conflict = await admin.call('POST', `/api/models/${modelId}/schema`,
      { changes: [{ op: 'MODIFY_FIELD', fieldKey: 'amount', patch: { label: '冲突测试' } }],
        baseVersion: 2, confirmToken: pre2.json?.confirmToken }, { 'X-App-Id': '1' });
    ok('旧 baseVersion 保存 409', conflict.status === 409 && conflict.json?.code === 'MODEL_VERSION_CONFLICT'
      && conflict.json?.details?.serverVersion === 3,
      `HTTP ${conflict.status} code=${conflict.json?.code} sv=${conflict.json?.details?.serverVersion}`);

    // ---------- 6. DELETE_FIELD 前端升档 CHECKBOX（UI 全链） ----------
    await cdp.reload();
    await cdp.waitFor('.ant-layout-header', 10000);
    await cdp.evalJs(`(() => { const cards = Array.from(document.querySelectorAll('.ant-card')); const c = cards.find(x => x.textContent.includes('报销管理')); (c?.querySelector('button') || c)?.click(); })()`);
    await cdp.waitFor('.ant-tabs', 8000);
    await clickTab('模型');
    await waitText(`验收模型${stamp}`, 8000);
    // 定位本次新建模型的画布节点（React Flow：.react-flow__node 内 .er-node 卡片含 modelKey）
    const editClick = await cdp.evalJs(`(() => {
      const nodes = Array.from(document.querySelectorAll('.react-flow__node'));
      const mine = nodes.find(n => n.textContent.includes('er_accept_' + '${stamp}'));
      const b = mine && Array.from(mine.querySelectorAll('button')).find(x => x.textContent.includes('编辑字段'));
      if (!b) return 'missing';
      b.click();
      return 'clicked';
    })()`);
    if (editClick === 'missing') throw new Error('未找到新建模型的编辑字段按钮');
    await cdp.waitFor('.ant-drawer', 5000);
    ok('抽屉字段渲染 amount', await waitText('amount', 5000));
    // 类型/标识禁用态：点击「修改」后 Select/Input disabled
    await clickByText(`document.querySelector('.ant-drawer')`, '修改');
    await new Promise((r) => setTimeout(r, 600));
    const disabledState = await cdp.evalJs(`(() => {
      const box = document.querySelector('.ant-drawer');
      const inputs = box.querySelectorAll('input.ant-input-disabled');
      return JSON.stringify({ disabledInputs: inputs.length, disabledSelect: !!box.querySelector('.ant-select-disabled') });
    })()`);
    ok('字段标识/类型禁用态呈现', JSON.parse(disabledState).disabledInputs >= 1 && JSON.parse(disabledState).disabledSelect === true, disabledState);
    // 取消修改 → 删除字段（Popconfirm CDP 真实点击确认）
    await clickByText(`document.querySelector('.ant-drawer')`, '取消');
    await new Promise((r) => setTimeout(r, 400));
    const delClick = await cdp.evalJs(`(() => {
      const items = Array.from(document.querySelectorAll('.ant-drawer .ant-list-item'));
      const target = items.find(i => i.textContent.includes('amount'));
      if (!target) return 'no-item';
      const del = Array.from(target.querySelectorAll('button')).find(b => b.textContent.includes('删除'));
      if (!del) return 'no-del-btn';
      del.click();
      return 'clicked';
    })()`);
    if (delClick !== 'clicked') throw new Error('删除按钮点击失败: ' + delClick);
    await new Promise((r) => setTimeout(r, 600));
    // Popconfirm 确认：显式等浮层出现后 fiber 直调主按钮
    await cdp.waitFor('.ant-popover .ant-btn-primary', 3000).catch(() => {});
    const popClick = await cdp.evalJs(`(() => {
      const pop = document.querySelector('.ant-popover');
      if (!pop) return 'no-popover';
      const b = pop.querySelector('.ant-btn-primary');
      if (!b) return 'no-primary:' + pop.innerText.slice(0, 40);
      b.click();
      return 'clicked';
    })()`);
    if (popClick !== 'clicked') throw new Error('Popconfirm 确认失败: ' + popClick);
    await new Promise((r) => setTimeout(r, 700));
    // 删除标记已在草稿（撤销按钮出现即 _deleted 置位）
    const strikeState = await cdp.evalJs(`(() => {
      const items = Array.from(document.querySelectorAll('.ant-drawer .ant-list-item'));
      const t = items.find(i => i.textContent.includes('amount'));
      const hasUndo = t ? Array.from(t.querySelectorAll('button')).some(b => b.textContent.includes('撤销')) : false;
      return JSON.stringify({ found: !!t, undo: hasUndo, text: t ? t.innerText.slice(0, 80) : '' });
    })()`);
    ok('删除标记入草稿（撤销按钮出现）', JSON.parse(strikeState).undo === true, strikeState);
    // 保存：确认弹层应为 CHECKBOX 升档（先断言按钮可点——disabled 即前端缺陷）
    const saveBtnState = await cdp.evalJs(`(() => {
      const norm = (s) => (s || '').replace(/[\\s\u3000]+/g, '');
      const b = Array.from(document.querySelectorAll('button')).find(x => norm(x.textContent).includes(norm('保存变更')));
      return JSON.stringify({ found: !!b, disabled: b ? b.disabled : null, text: b ? b.textContent.trim() : '' });
    })()`);
    const saveBtn = JSON.parse(saveBtnState);
    ok('删除变更后保存按钮可点', saveBtn.found && saveBtn.disabled === false, saveBtnState);
    // 原生 click 触发保存（React 18 完整事件链——fiber 直调对 async handler 不可靠）
    await clickByText(`document`, '保存变更');
    await cdp.waitFor('.ant-modal', 8000);
    const delModal = await cdp.text('.ant-modal');
    ok('删除保存弹层含删除操作警示', delModal?.includes('含删除操作') && delModal?.includes('删除'), (delModal ?? '').slice(0, 160));
    // 勾选「我已了解」后保存
    await cdp.evalJs(`(() => { const boxes = Array.from(document.querySelectorAll('.ant-modal input[type="checkbox"]')); boxes.forEach(c => { if (!c.checked) c.click(); }); })()`);
    await new Promise((r) => setTimeout(r, 400));
    await clickByText(`document.querySelector('.ant-modal')`, '确认保存');
    await new Promise((r) => setTimeout(r, 900));
    ok('删除保存成功（v4）', await waitText('已保存（v4）', 6000));
    const dbDeleted = dbQuery(`SELECT field_status FROM meta_field WHERE model_id = ${modelId} AND field_key = 'amount'`);
    ok('字段软删落库（DELETED 非物理删）', dbDeleted.length === 1 && dbDeleted[0].includes('DELETED'), JSON.stringify(dbDeleted));
    await cdp.shot('er-deleted-checkbox');

    // ---------- 7. TYPE_MODEL_NAME 档（≥3 页面引用后删字段 → API 断言） ----------
    // 负例：删除已删字段——后端幂等设计返回 200（重复删除不报错不复活）
    const preDel = await admin.call('POST', `/api/models/${modelId}/precheck`,
      { changes: [{ op: 'DELETE_FIELD', fieldKey: 'amount' }] }, { 'X-App-Id': '1' });
    ok('重复删除幂等（200 非报错）', preDel.status === 200, `HTTP ${preDel.status} code=${preDel.json?.code}`);
    // 主路径：新字段 → 3 页面引用 → 删字段 TYPE_MODEL_NAME
    const addRef = await admin.call('POST', `/api/models/${modelId}/precheck`,
      { changes: [{ op: 'ADD_FIELD', fieldKey: 'hot_field', field: { label: '热字段', type: 'text' } }] }, { 'X-App-Id': '1' });
    await admin.call('POST', `/api/models/${modelId}/schema`,
      { changes: [{ op: 'ADD_FIELD', fieldKey: 'hot_field', field: { label: '热字段', type: 'text' } }],
        baseVersion: 4, confirmToken: addRef.json.confirmToken }, { 'X-App-Id': '1' });
    dbQuery(`INSERT INTO meta_field_reference (tenant_id, model_id, field_key, ref_type, ref_id) SELECT 1, ${modelId}, 'hot_field', 'PAGE', id FROM generate_series(9101, 9103) AS id`);
    const preHot = await admin.call('POST', `/api/models/${modelId}/precheck`,
      { changes: [{ op: 'DELETE_FIELD', fieldKey: 'hot_field' }] }, { 'X-App-Id': '1' });
    ok('≥3 页面引用删字段 → TYPE_MODEL_NAME', preHot.status === 200 && preHot.json?.confirmMode === 'TYPE_MODEL_NAME'
      && preHot.json?.maxSeverity === 'HIGH',
      `mode=${preHot.json?.confirmMode} sev=${preHot.json?.maxSeverity}`);
    const noName = await admin.call('POST', `/api/models/${modelId}/schema`,
      { changes: [{ op: 'DELETE_FIELD', fieldKey: 'hot_field' }], baseVersion: 5, confirmToken: preHot.json.confirmToken },
      { 'X-App-Id': '1' });
    ok('TYPE_MODEL_NAME 缺 confirmValue 被拒', noName.status === 422 && noName.json?.code === 'CONFIRM_TOKEN_INVALID',
      `HTTP ${noName.status}`);
    const badName = await admin.call('POST', `/api/models/${modelId}/schema`,
      { changes: [{ op: 'DELETE_FIELD', fieldKey: 'hot_field' }], baseVersion: 5,
        confirmToken: preHot.json.confirmToken, confirmValue: '错误的名字' }, { 'X-App-Id': '1' });
    ok('confirmValue 不等值被拒', badName.status === 422 && badName.json?.code === 'CONFIRM_TOKEN_INVALID',
      `HTTP ${badName.status}`);
    const goodName = await admin.call('POST', `/api/models/${modelId}/schema`,
      { changes: [{ op: 'DELETE_FIELD', fieldKey: 'hot_field' }], baseVersion: 5,
        confirmToken: preHot.json.confirmToken, confirmValue: `验收模型${stamp}` }, { 'X-App-Id': '1' });
    ok('模型名等值删除成功 v6', goodName.status === 200 && goodName.json?.version === 6,
      `HTTP ${goodName.status} body=${goodName.raw.slice(0, 120)}`);

    // ---------- 8. 版本时间线与回滚（UI 全链：回滚到 v3 复活 amount） ----------
    await cdp.reload();
    await cdp.waitFor('.ant-layout-header', 10000);
    await cdp.evalJs(`(() => { const cards = Array.from(document.querySelectorAll('.ant-card')); const c = cards.find(x => x.textContent.includes('报销管理')); (c?.querySelector('button') || c)?.click(); })()`);
    await cdp.waitFor('.ant-tabs', 8000);
    await clickTab('模型');
    await waitText(`验收模型${stamp}`, 8000);
    // 点新建模型画布节点选中（详情就绪后版本时间线按钮才可用）
    await cdp.evalJs(`(() => {
      const nodes = Array.from(document.querySelectorAll('.react-flow__node'));
      const mine = nodes.find(n => n.textContent.includes('er_accept_' + '${stamp}'));
      if (mine) mine.click();
    })()`);
    // 等详情就绪（选中卡片触发 ensureDetail——按钮从 disabled 转可用）
    await new Promise((r) => setTimeout(r, 1200));
    const versionsBtnState = await cdp.evalJs(`(() => {
      const norm = (s) => (s || '').replace(/[\\s\u3000]+/g, '');
      const b = Array.from(document.querySelectorAll('button')).find(x => norm(x.textContent).includes(norm('版本时间线')));
      return JSON.stringify({ found: !!b, disabled: b ? b.disabled : null });
    })()`);
    const versionsBtn = JSON.parse(versionsBtnState);
    ok('版本时间线按钮可用（详情就绪）', versionsBtn.found && versionsBtn.disabled === false, versionsBtnState);
    await clickByText(`document`, '版本时间线');
    await cdp.waitFor('.ant-drawer .ant-timeline', 8000);
    const timeline = await cdp.text('.ant-drawer .ant-timeline');
    ok('时间线渲染 v1-v6', timeline?.includes('v6') && timeline?.includes('v1'),
      (timeline ?? '').slice(0, 160));
    await cdp.shot('er-timeline');
    // 回滚到 v3（amount 活跃版）
    await cdp.evalJs(`(() => {
      const items = Array.from(document.querySelectorAll('.ant-drawer .ant-timeline-item'));
      const v3 = items.find(i => i.textContent.includes('v3'));
      const b = v3 && Array.from(v3.querySelectorAll('button')).find(x => x.textContent.includes('回滚'));
      b?.click();
    })()`);
    await cdp.waitFor('.ant-modal input', 5000).catch(() => {});
    const rbModal = await cdp.text('.ant-modal');
    ok('回滚确认弹层要求输入模型名', rbModal?.includes('回滚') && rbModal?.includes('数据零操作'),
      (rbModal ?? '').slice(0, 140));
    const rbDisabled = await cdp.evalJs(`(() => { const m = document.querySelector('.ant-modal'); const b = Array.from(m.querySelectorAll('button')).find(x => x.textContent.includes('确认回滚')); return JSON.stringify({ disabled: b ? b.disabled : null }); })()`);
    ok('回滚未输入模型名前禁用', JSON.parse(rbDisabled).disabled === true, rbDisabled);
    await cdp.fill('.ant-modal input', `验收模型${stamp}`);
    // 新交互：预检影响面先呈现（确认按钮在 rollbackPre 就绪前禁用）——等影响面列表出现
    const preReady = await waitText('回滚影响面', 8000);
    ok('回滚预检影响面呈现', preReady, preReady ? '' : '预检未在 8s 内返回');
    await cdp.fill('.ant-modal input', `验收模型${stamp}`);
    // 轮询等确认按钮转可用（rollbackPre 渲染完成后 disabled 解除——固定 sleep 有竞态）
    const btnReady = await cdp.evalJs(`(() => new Promise((resolve) => {
      const deadline = Date.now() + 8000;
      const probe = () => {
        const m = document.querySelector('.ant-modal');
        const b = m && Array.from(m.querySelectorAll('button')).find(x => x.textContent.includes('确认回滚'));
        if (b && !b.disabled) return resolve('ready');
        if (Date.now() > deadline) return resolve('timeout');
        setTimeout(probe, 200);
      };
      probe();
    }))()`);
    ok('回滚确认按钮转可用', btnReady === 'ready', btnReady === 'ready' ? '' : await cdp.evalJs(`(() => {
      const m = document.querySelector('.ant-modal');
      if (!m) return 'no-modal';
      const b = Array.from(m.querySelectorAll('button')).find(x => x.textContent.includes('确认回滚'));
      const input = m.querySelector('input');
      return JSON.stringify({
        btnDisabled: b ? b.disabled : null, btnClass: b ? b.className : null,
        inputValue: input ? input.value : null,
        modalText: (m.textContent || '').slice(0, 260),
      });
    })()`));
    await clickByText(`document.querySelector('.ant-modal')`, '确认回滚');
    await new Promise((r) => setTimeout(r, 1000));
    ok('回滚成功提示（生成新版本）', await waitText('已回滚到 v3', 6000));
    const dbAfter = dbQuery(`SELECT current_version FROM meta_model WHERE id = ${modelId}`);
    ok('回滚生成新版本 v7 落库', dbAfter[0]?.startsWith('7'), JSON.stringify(dbAfter));
    const dbRevive = dbQuery(`SELECT field_status FROM meta_field WHERE model_id = ${modelId} AND field_key = 'amount'`);
    ok('回滚复活 amount 字段（ACTIVE）', dbRevive.length === 1 && dbRevive[0].includes('ACTIVE'), JSON.stringify(dbRevive));
    const dbRbMark = dbQuery(`SELECT rollback_from FROM meta_schema_version WHERE model_id = ${modelId} AND version = 7`);
    ok('rollback_from=3 标记落库', dbRbMark.length === 1 && dbRbMark[0].startsWith('3'), JSON.stringify(dbRbMark));
    await cdp.shot('er-rollback-done');

    // ---------- 9. 越权负例：普通成员不可建模 ----------
    const user = new ApiClient('user');
    await user.login('API 普通成员登录', 'accept_user', process.env.ACCEPT_PASSWORD || 'Accept!2026');
    const userCreate = await user.call('POST', '/api/models', { modelKey: `hijack_${stamp}`, name: '越权模型' },
      { 'X-App-Id': '1' });
    ok('普通成员建模被拒（403）', userCreate.status === 403, `HTTP ${userCreate.status}`);
    const userPre = await user.call('POST', `/api/models/${modelId}/precheck`,
      { changes: [{ op: 'DELETE_FIELD', fieldKey: 'amount' }] }, { 'X-App-Id': '1' });
    ok('普通成员 precheck 被拒（403）', userPre.status === 403, `HTTP ${userPre.status}`);

    // ---------- 9b. 跨应用越权：应用 A 设计者不可携 A 的头操作应用 B 的模型 ----------
    // 管理员建第二个应用（若已存在则复用）；把模型挂在应用 1，携 X-App-Id: 2 访问必须 404 同判
    const apps = await admin.call('GET', '/api/apps', null);
    let app2 = (apps.json?.list ?? []).find((a) => a.id !== '1');
    if (!app2) {
      const created2 = await admin.call('POST', '/api/apps', { name: `越权靶应用${stamp}` });
      app2 = created2.json;
    }
    if (app2?.id) {
      const crossRead = await admin.call('GET', `/api/models/${modelId}`, null, { 'X-App-Id': String(app2.id) });
      ok('跨应用读模型被拒（404 同判）', crossRead.status === 404, `HTTP ${crossRead.status}`);
      const crossPre = await admin.call('POST', `/api/models/${modelId}/precheck`,
        { changes: [{ op: 'ADD_FIELD', fieldKey: 'evil', field: { label: '越权', type: 'text' } }] },
        { 'X-App-Id': String(app2.id) });
      ok('跨应用 precheck 被拒（404 同判）', crossPre.status === 404, `HTTP ${crossPre.status}`);
      const crossRollback = await admin.call('POST', `/api/models/${modelId}/rollback/precheck`,
        { targetVersion: 3 }, { 'X-App-Id': String(app2.id) });
      ok('跨应用回滚预检被拒（404 同判）', crossRollback.status === 404, `HTTP ${crossRollback.status}`);
    } else {
      // 应用列表不可达时跳过（不静默 PASS——显式登记跳过原因）
      record('跨应用越权断言', false, 'apps 列表不可达，无法构造第二应用');
    }

    // ---------- 10. console 错误 ----------
    const errs = cdp.errors().filter((e) => !e.includes('favicon'));
    ok('无未捕获 console 错误', errs.length === 0, errs.slice(0, 3).join(' | ').slice(0, 200));

    summary('er-modeler');
  } finally {
    await cdp.close();
  }
})().catch((e) => {
  console.error('FATAL:', e.message);
  summary('er-modeler');
  process.exitCode = 1;
});
