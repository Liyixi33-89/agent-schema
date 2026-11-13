/**
 * M16 附件上传闭环验收（spec 016 T1 / A1——M15 deferred 项）
 *
 * 链路：模型扩展 file 字段（两段式）→ 表单页绑定 FileUpload 物料 → 发布
 *      → 浏览器真实交互：选择文件（CDP DataTransfer 注入 input[type=file]）
 *      → presign→直传→complete（网络断言）→ 回显 → 提交落库（DB 断言 fileId）
 *      → 详情页回显 → 下载凭证签发 → 下载内容一致性（sha256 与上传源一致）
 * 负例：超 10MB 提交被拒（A1 明确要求超限拒绝；服务端 attachment scope 上限 100MB，
 *      单请求直传阈值 20MB——超 10MB 断点取 spec A1 口径：物料侧 maxCount/P1 校验 +
 *      presign 超阈值走 multipart 拒绝路径；本套件以「超大文件 presign 被拒」为服务端断言，
 *      物料前端 beforeUpload 校验为产品侧断言）
 * 纪律：与 accept-m15-mvp 同构——凭据外置、时间戳唯一键、三面核对、清理闭环。
 */
const { ApiClient, ok, record, summary, dbQuery, credentials } = require('./accept-lib.cjs');
const cdp = require('./cdp.cjs');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');

const BASE = process.env.ACCEPT_BASE_URL || 'http://127.0.0.1:8090';
const APP_ID = Number(process.env.ACCEPT_APP_ID || 1);
const MODEL_ID = Number(process.env.ACCEPT_MODEL_ID || 1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function stamp() { return Date.now().toString(36); }
const sha256File = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// 与 mvp 套件同构的浏览器页面基址拼接
const IS_PUBLIC_TARGET = process.env.ACCEPT_PUBLIC_MODE === '1'
  || /127\.0\.0\.1|localhost/.test(BASE) === false;
const WEB_PREFIX = IS_PUBLIC_TARGET ? '/accept/' : '/';
const webUrl = (p) => `${BASE.replace(/\/$/, '')}${WEB_PREFIX}${String(p).replace(/^\//, '')}`;

let browserIdentityVerified = false;
async function loginViaBrowser(username, password) {
  await cdp.goto(webUrl('/runtime/'));
  await sleep(2000);
  const probe = await cdp.evalJs(`(async () => {
    try { const r = await fetch('/api/me', { credentials: 'same-origin' });
      return r.ok ? JSON.stringify(await r.json()) : null; } catch { return null; } })()`);
  if (probe && probe !== 'null'
    && String(JSON.parse(probe).account) === String(username)) { browserIdentityVerified = true; return; }
  await cdp.goto(webUrl('/designer/'));
  await sleep(1500);
  await cdp.fill('input[placeholder="账号"]', username);
  await cdp.fill('input[placeholder="密码"]', password);
  await cdp.mouseClick('button[type="submit"]');
  await sleep(2200);
  const after = await cdp.evalJs(`(async () => {
    try { const r = await fetch('/api/me', { credentials: 'same-origin' });
      return r.ok ? JSON.stringify(await r.json()) : null; } catch { return null; } })()`);
  browserIdentityVerified = !!after && after !== 'null' && String(JSON.parse(after).account) === String(username);
  if (!browserIdentityVerified) throw new Error(`浏览器身份核验失败：期望 ${username}，实际 ${after || '未登录'}`);
}

const FILL_JS = `(label, value) => {
  const set = (el, v) => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true })); };
  const lbl = Array.from(document.querySelectorAll('label')).find(l => l.textContent.includes(txt = label));
  if (!lbl) return false; const fi = lbl.closest('.ant-form-item'); const el = fi?.querySelector('input, textarea');
  if (!el) return false; set(el, value); return true; }`;

/** CDP 注入本地文件到 input[type=file] 并派发 change（React 受控链触发 customRequest）。 */
async function setInputFile(filePath, mime) {
  const fileChooser = `(() => {
    const input = document.querySelector('input[type=file]');
    if (!input) return 'no-input';
    return 'ready';
  })()`;
  const ready = await cdp.evalJs(fileChooser);
  if (ready !== 'ready') throw new Error('FileUpload 物料 input[type=file] 未找到: ' + ready);
  // DOM.setFileInputFiles（CDP 原生——绕过 headless 无文件选择器限制）
  const targets = JSON.parse(await new Promise((resolve, reject) => {
    const http = require('http');
    http.get(`http://127.0.0.1:${cdp.PORT}/json/list`, (r) => {
      let d = ''; r.on('data', (c) => d += c); r.on('end', () => resolve(d));
    }).on('error', reject);
  }));
  const page = targets.find((t) => t.type === 'page');
  await cdp.send('DOM.enable').catch(() => {});
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId, selector: 'input[type=file]',
  });
  if (!nodeId) throw new Error('DOM.querySelector 未定位 input[type=file]');
  const winPath = filePath.replace(/\//g, '\\');
  await cdp.send('DOM.setFileInputFiles', { files: [winPath], nodeId });
  await sleep(300);
}

async function main() {
  const st = stamp();
  const creds = credentials();
  const designer = creds.designer;
  const bizUser = creds.user;
  const admin = new ApiClient('m16-attach-designer');
  const user = new ApiClient('m16-attach-user');
  await admin.login('M16A-设计者登录', designer.username, designer.password);
  await user.login('M16A-业务用户登录', bizUser.username, bizUser.password);

  const createdPages = [];
  const createdFieldKey = `m16att_${st}`;
  const createdRecordIds = [];
  let uploadedFileId = null;

  // 上传源文件（含可核对内容）与超限文件
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm16-attach-'));
  const goodFile = path.join(tmpDir, `m16-附件-${st}.txt`);
  const goodContent = `M16 附件闭环验收 ${st}\n` + 'A'.repeat(2048);
  fs.writeFileSync(goodFile, goodContent);
  const goodSha = sha256File(goodFile);
  const bigFile = path.join(tmpDir, `m16-超限-${st}.bin`);
  // 11MB——超 A1 口径 10MB 且低于 20MB 单请求阈值（走 presign 大小校验拒绝路径）
  fs.writeFileSync(bigFile, Buffer.alloc(11 * 1024 * 1024, 0x42));

  try {
    // ============ A-01 模型扩展 file 字段（两段式真实链路） ============
    const rModel = await admin.call('GET', `/api/models/${MODEL_ID}`, null, { 'X-App-Id': String(APP_ID) });
    const baseVersion = rModel.json?.currentVersion;
    const modelName = rModel.json?.name;
    ok('A01-模型详情读取（版本基线）', rModel.status === 200 && typeof baseVersion === 'number',
      `HTTP ${rModel.status} v=${baseVersion}`);
    const FILE_FIELD = { label: '发票附件(验收)', type: 'file' };
    const CHANGE = { op: 'ADD_FIELD', fieldKey: createdFieldKey, field: FILE_FIELD };
    const pre = await admin.call('POST', `/api/models/${MODEL_ID}/precheck`,
      { changes: [CHANGE] }, { 'X-App-Id': String(APP_ID) });
    ok('A01-file 字段扩展 precheck 通过', pre.status === 200 && !!pre.json?.confirmToken,
      `HTTP ${pre.status}${pre.status !== 200 ? ' ' + pre.raw.slice(0, 140) : ` mode=${pre.json?.confirmMode}`}`);
    const rSchema = await admin.call('POST', `/api/models/${MODEL_ID}/schema`, {
      changes: [CHANGE], baseVersion, confirmToken: pre.json.confirmToken,
    }, { 'X-App-Id': String(APP_ID) });
    ok('A01-file 字段保存成功', rSchema.status === 200,
      `HTTP ${rSchema.status}${rSchema.status !== 200 ? ' ' + rSchema.raw.slice(0, 140) : ''}`);
    const dbField = dbQuery(`SELECT field_type FROM meta_field WHERE model_id=${MODEL_ID} AND field_key='${createdFieldKey}'`);
    ok('A01-file 字段落库核对', dbField.length === 1 && String(dbField[0]) === 'file', JSON.stringify(dbField));

    // ============ A-02 表单页绑定 FileUpload 物料 + 发布 ============
    const formKey = `m16form_${st}`;
    const rForm = await admin.call('POST', `/api/pages`, {
      appId: APP_ID, pageKey: formKey, name: `M16附件表单${st}`, type: 'FORM',
      modelId: MODEL_ID, path: `/${formKey}` });
    ok('A02-新建 FORM 页', rForm.status === 200, `HTTP ${rForm.status}`);
    const formPageId = rForm.json?.id;
    createdPages.push(formPageId);
    const rDraft = await admin.call('GET', `/api/pages/${formPageId}/draft`);
    const schema = rDraft.json.schema;
    const baseDraftV = rDraft.json.draftVersion;
    schema.layout = [
      { id: `fi-1-${st}`, componentName: 'FormItem', props: { label: '报销事由' },
        children: [{ id: `fn-1-${st}`, componentName: 'TextInput', fieldRef: 'title', props: {} }] },
      { id: `fi-1b-${st}`, componentName: 'FormItem', props: { label: '金额' },
        children: [{ id: `fn-1b-${st}`, componentName: 'NumberInput', fieldRef: 'amount', props: {} }] },
      { id: `fi-2-${st}`, componentName: 'FormItem', props: { label: '发票附件' },
        children: [{ id: `fn-2-${st}`, componentName: 'FileUpload', fieldRef: createdFieldKey, props: {} }] },
    ];
    const rSave = await admin.call('PUT', `/api/pages/${formPageId}/draft`,
      { schema, baseDraftVersion: baseDraftV });
    ok('A02-表单草稿保存（FileUpload 绑定 file 字段）', rSave.status === 200, `HTTP ${rSave.status}`);
    const rPub = await admin.call('POST', `/api/apps/${APP_ID}/publish`, {
      pageIds: [formPageId], changelog: `M16 附件验收发布 ${st}` });
    ok('A02-页面发布成功', rPub.status === 200,
      `HTTP ${rPub.status}${rPub.status !== 200 ? ' ' + rPub.raw.slice(0, 140) : ` release=${rPub.json?.releaseVersion}`}`);

    // 业务用户授权 user 角色 + SELF 范围（提交可见性前提——与 mvp 套件同构）
    const meUser = await user.call('GET', '/api/me');
    const bizUserId = meUser.json?.userId ?? meUser.json?.id;
    await admin.call('PUT', `/api/apps/${APP_ID}/members/${bizUserId}`, { roles: ['user'] });
    dbQuery(`DELETE FROM sys_role_data_scope WHERE model_id=${MODEL_ID} AND scope_type='SELF' AND role_id IN (SELECT id FROM sys_role WHERE app_id=${APP_ID} AND code='user')`);
    const userRoleId = dbQuery(`SELECT id FROM sys_role WHERE app_id=${APP_ID} AND code='user' AND tenant_id=1`)[0];
    dbQuery(`INSERT INTO sys_role_data_scope (role_id, model_id, scope_type) VALUES (${userRoleId}, ${MODEL_ID}, 'SELF') ON CONFLICT DO NOTHING`);

    // ============ A-03 浏览器真实上传交互 ============
    await cdp.launch();
    try {
      await loginViaBrowser(bizUser.username, bizUser.password);
      ok('A03-浏览器身份核验（业务用户）', browserIdentityVerified === true, 'identity=true');
      const recTitle = `M16ATT-${st}`;
      await cdp.goto(webUrl(`/runtime/#/page/${formPageId}`));
      await cdp.waitFor('input', 10000);
      await sleep(1500);
      await cdp.shot('m16a-form-empty');
      // 物料可见性
      const uploadBtn = await cdp.evalJs(`(() => {
        const bs = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('上传附件'));
        return bs.length; })()`);
      ok('A03-FileUpload 物料渲染（上传附件按钮可见）', Number(uploadBtn) === 1, `buttons=${uploadBtn}`);

      await cdp.evalJs(`(${FILL_JS})('报销事由', '${recTitle}')`);
      await cdp.evalJs(`(() => { const lbl = Array.from(document.querySelectorAll('label')).find(l => l.textContent.includes('金额'));
        const fi = lbl && lbl.closest('.ant-form-item'); const el = fi && fi.querySelector('input');
        if (!el) return 'no-amount-input';
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '88');
        el.dispatchEvent(new Event('input', { bubbles: true })); return 'amount-filled'; })()`);

      // 选择文件（CDP 注入）→ 网络断言 presign/PUT/complete
      await cdp.startNetwork();
      await setInputFile(goodFile, 'text/plain');
      // 等待上传链完成（presign→PUT→complete→回显）
      let uploadDone = false;
      for (let i = 0; i < 30 && !uploadDone; i++) {
        await sleep(500);
        uploadDone = await cdp.evalJs(`(() => {
          const items = Array.from(document.querySelectorAll('.ant-upload-list-item'));
          return items.some(it => it.textContent.includes('done') || it.className.includes('done')); })()`);
      }
      const reqs = cdp.networkRequests();
      const presignReq = reqs.find((r) => r.url.includes('/api/files/presign') && r.method === 'POST');
      const putReq = reqs.find((r) => /local-put|\/put\?/.test(r.url) && r.method === 'PUT');
      const completeReq = reqs.find((r) => /\/complete/.test(r.url) && r.method === 'POST');
      ok('A03-presign 凭证签发请求发出且成功', !!presignReq && presignReq.status === 200,
        presignReq ? `POST ${presignReq.status}` : '未捕获 presign');
      ok('A03-直传 PUT 请求发出且成功', !!putReq && putReq.status === 200,
        putReq ? `PUT ${putReq.status} ${putReq.url.slice(-40)}` : '未捕获 PUT');
      ok('A03-complete 确认请求发出且成功', !!completeReq && completeReq.status === 201 || completeReq?.status === 200,
        completeReq ? `POST ${completeReq.status}` : '未捕获 complete');

      // 回显断言：文件名出现在上传列表
      const echoName = await cdp.evalJs(`(() => {
        const items = Array.from(document.querySelectorAll('.ant-upload-list-item-name, .ant-upload-list-item'));
        return items.map(i => i.textContent).join('|'); })()`);
      ok('A03-上传完成后回显文件名', String(echoName).includes('m16-附件'),
        String(echoName).slice(0, 120));

      // 提交（附件随 payload 落库）——先滚动按钮进视口再真实坐标点击
      const btnInView = await cdp.evalJs(`(() => { const bs = Array.from(document.querySelectorAll('button')).filter(x => x.textContent.replace(/\\s/g,'').includes('提交'));
        if (!bs.length) return 'no-btn';
        const btn = bs[bs.length - 1];
        btn.setAttribute('data-host-submit', '1');
        btn.scrollIntoView({ block: 'center' });
        const r = btn.getBoundingClientRect();
        return JSON.stringify({ n: bs.length, x: r.x, y: r.y, w: r.width, h: r.height }); })()`);
      ok('A03-提交按钮定位且在视口内', (() => {
        try { const b = JSON.parse(btnInView); return b.n >= 1 && b.y >= 0 && b.y < 900; }
        catch { return false; }
      })(), String(btnInView).slice(0, 120));
      await cdp.mouseClick('button[data-host-submit]');
      await sleep(3500);
      await cdp.shot('m16a-form-submitted');
      const writeReq = cdp.networkRequests().filter((r) => r.url.endsWith(`/api/data/${MODEL_ID}`) && r.method === 'POST').pop();
      ok('A03-提交写入接口 200', !!writeReq && writeReq.status === 200,
        writeReq ? `POST ${writeReq.status}` : '未捕获写入请求');

      // DB 断言：file 字段值 {fileId, name, size}
      const dbRow = dbQuery(`SELECT data->'${createdFieldKey}'->>'fileId', data->'${createdFieldKey}'->>'name', data->>'title' FROM biz_model_${MODEL_ID} WHERE data->>'title'='${recTitle}'`);
      const fid = dbRow.length === 1 ? String(dbRow[0]).split('|')[0] : '';
      ok('A03-附件随提交落库（fileId/name 结构完整）',
        dbRow.length === 1 && /^\d+$/.test(fid) && String(dbRow[0]).includes('m16-附件'),
        JSON.stringify(dbRow));
      uploadedFileId = fid;
      const recId = dbQuery(`SELECT id FROM biz_model_${MODEL_ID} WHERE data->>'title'='${recTitle}'`)[0];
      createdRecordIds.push(recId);

      // ============ A-04 详情页回显 + 下载 ============
      await cdp.startNetwork();
      await cdp.goto(webUrl(`/runtime/#/page/${formPageId}/${recId}`));
      await cdp.waitFor('input', 10000);
      await sleep(2000);
      const detailReq = cdp.networkRequests().find((r) => new RegExp(`/api/data/${MODEL_ID}/\\d+`).test(String(r.url)) && r.method === 'GET');
      ok('A04-详情接口请求可达', !!detailReq,
        detailReq ? `GET ${detailReq.status} ${String(detailReq.url).slice(-30)}` : '未捕获 detail 请求');
      ok('A04-详情接口 200 可见', !!detailReq && detailReq.status === 200,
        detailReq ? `HTTP ${detailReq.status}` : 'n/a');
      await cdp.shot('m16a-detail');
      const detailEcho = await cdp.evalJs(`(() => {
        const items = Array.from(document.querySelectorAll('.ant-upload-list-item-name, .ant-upload-list-item'));
        return items.map(i => i.textContent).join('|'); })()`);
      ok('A04-详情页附件回显', String(detailEcho).includes('m16-附件'),
        String(detailEcho).slice(0, 120));

      // 下载（onPreview → 一次性凭证 → 内容核对）——点击 name span（AntD onPreview 绑定点；
      // 注意不能选 .ant-upload-list-item 容器——容器无 onClick，点击静默）
      const downloaded = path.join(tmpDir, 'downloaded.txt');
      const dlProbe = await cdp.evalJs(`(async () => {
        const names = Array.from(document.querySelectorAll('.ant-upload-list-item-name'));
        const it = names.find(x => x.textContent.includes('m16-附件'));
        if (!it) return 'no-name:' + names.length;
        it.click();
        await new Promise((r) => setTimeout(r, 800));
        return 'clicked';
      })()`);
      ok('A04-详情页点击附件名触发下载', dlProbe === 'clicked', String(dlProbe));
      // 凭证请求可能异步延迟——轮询捕获（最多 6s）
      let dlUrlReq = null;
      for (let i = 0; i < 12 && !dlUrlReq; i++) {
        await sleep(500);
        dlUrlReq = cdp.networkRequests().find((r) => String(r.url).includes(`/api/files/${fid}/url`));
      }
      ok('A04-下载凭证接口调用成功', !!dlUrlReq && dlUrlReq.status === 200,
        dlUrlReq ? `GET ${dlUrlReq.status}` : '未捕获凭证请求');

      // Node 侧独立下载核对（凭证通道 + 内容 sha256 一致）
      const metaResp = await user.call('GET', `/api/files/${fid}`);
      ok('A04-附件元数据读取（同租户可见）', metaResp.status === 200,
        `HTTP ${metaResp.status}${metaResp.status !== 200 ? ' ' + metaResp.raw.slice(0, 120) : ` name=${metaResp.json?.fileName}`}`);
      const dlApi = await user.call('GET', `/api/files/${fid}/url`);
      const dlUrl = dlApi.json?.downloadUrl;
      ok('A04-下载凭证签发（API 通道）', dlApi.status === 200 && !!dlUrl,
        `HTTP ${dlApi.status} url=${dlUrl ? '签发' : '缺失'}`);
      if (dlUrl) {
        const abs = dlUrl.startsWith('http') ? dlUrl : `${BASE}${dlUrl}`;
        const content = execSync(`curl.exe -s "${abs}"`, { timeout: 30000 });
        const dlSha = createHash('sha256').update(content).digest('hex');
        ok('A04-下载内容与上传源一致（sha256）', dlSha === goodSha,
          `下载 ${content.length}B sha=${dlSha.slice(0, 12)}… 源 ${goodContent.length}B sha=${goodSha.slice(0, 12)}…`);
      }

      // ============ A-05 负例：非法附件拒绝 ============
      // 服务端校验序：类型白名单先于大小校验（FileService.validateScope）。
      // ① 类型负例（API 侧）：octet-stream 非白名单 → 400 FILE_TYPE_FORBIDDEN。
      const rBad = await user.call('POST', '/api/files/presign', {
        fileName: `m16-非法-${st}.bin`, contentType: 'application/octet-stream',
        size: 1024, scope: 'attachment' });
      ok('A05-非法类型附件 presign 被拒（类型白名单）',
        rBad.status === 400 && (rBad.json?.code || '') === 'FILE_TYPE_FORBIDDEN',
        `HTTP ${rBad.status} code=${rBad.json?.code}`);
      // ② 服务端大小上限锚点：attachment scope 上限 100MB（FilePolicy）——超限拒绝。
      //    （10MB 是 A1 产品侧试点约束，由物料 beforeUpload 前端拦截——见 ③）
      const rOver = await user.call('POST', '/api/files/presign', {
        fileName: `m16-超限-${st}.zip`, contentType: 'application/zip',
        size: 101 * 1024 * 1024, scope: 'attachment' });
      ok('A05-超 100MB 服务端上限附件 presign 被拒（FILE_TOO_LARGE）',
        (rOver.status === 413 || rOver.status === 422) && String(rOver.json?.code || '').includes('FILE_TOO_LARGE'),
        `HTTP ${rOver.status} code=${rOver.json?.code}`);

      // ③ 物料侧 10MB 拦截（A1 产品口径——浏览器真实注入 11MB 文件验证不发 presign）
      await cdp.goto(webUrl(`/runtime/#/page/${formPageId}`));
      await cdp.waitFor('input[type=file]', 10000);
      await sleep(1500);
      await cdp.startNetwork();
      await setInputFile(bigFile, 'application/octet-stream');
      await sleep(2500);
      const bigReqs = cdp.networkRequests().filter((r) => String(r.url).includes('/api/files/presign'));
      const bigToast = await cdp.evalJs(`(() => {
        const msgs = Array.from(document.querySelectorAll('.ant-message-notice-content'));
        return msgs.map(m => m.textContent).join('|'); })()`);
      ok('A05-超 10MB 物料前端拦截（不发 presign + toast 提示）',
        bigReqs.length === 0 && String(bigToast).includes('10MB'),
        `presign 发出 ${bigReqs.length} 次；toast=${String(bigToast).slice(0, 80)}`);

      const errs = cdp.errors().filter((e) => !String(e).includes('favicon'));
      ok('A-无未捕获 console 错误', errs.length === 0, errs.slice(0, 3).join(' | ').slice(0, 200));
    } finally {
      await cdp.close();
    }

    summary('m16-attachment');
  } finally {
    // ============ 清理闭环 ============
    for (const rid of createdRecordIds) {
      try { dbQuery(`DELETE FROM biz_model_${MODEL_ID} WHERE id=${rid}`); console.log(`[cleanup] 删除记录 ${rid}`); }
      catch (e) { console.log(`[cleanup] 记录删除失败: ${e.message}`); }
    }
    if (uploadedFileId) {
      try {
        const rDel = await admin.call('DELETE', `/api/files/${uploadedFileId}`);
        console.log(`[cleanup] 删除附件对象 ${uploadedFileId}: HTTP ${rDel?.status}`);
      } catch (e) { console.log(`[cleanup] 附件删除失败: ${e.message}`); }
    }
    for (const pid of createdPages) {
      try { const rDel = await admin.call('DELETE', `/api/pages/${pid}`); console.log(`[cleanup] 删除页面 ${pid}: HTTP ${rDel?.status}`); }
      catch (e) { console.log(`[cleanup] 页面 ${pid} 删除失败: ${e.message}`); }
    }
    // 字段恢复：两段式删除本轮 file 字段
    try {
      const rModelNow = await admin.call('GET', `/api/models/${MODEL_ID}`, null, { 'X-App-Id': String(APP_ID) });
      const preDel = await admin.call('POST', `/api/models/${MODEL_ID}/precheck`,
        { changes: [{ op: 'DELETE_FIELD', fieldKey: createdFieldKey }] }, { 'X-App-Id': String(APP_ID) });
      if (preDel.status === 200 && preDel.json?.confirmToken) {
        await admin.call('POST', `/api/models/${MODEL_ID}/schema`, {
          changes: [{ op: 'DELETE_FIELD', fieldKey: createdFieldKey }],
          baseVersion: rModelNow.json?.currentVersion, confirmToken: preDel.json.confirmToken,
        }, { 'X-App-Id': String(APP_ID) });
        console.log(`[cleanup] 删除字段 ${createdFieldKey}: OK`);
      } else {
        console.log(`[cleanup] 字段删除 preskip: ${preDel.status}`);
      }
    } catch (e) { console.log(`[cleanup] 字段恢复失败: ${e.message}`); }
    dbQuery(`DELETE FROM sys_role_data_scope WHERE model_id=${MODEL_ID} AND scope_type='SELF' AND role_id IN (SELECT id FROM sys_role WHERE app_id=${APP_ID} AND code='user')`);
    console.log('[cleanup] SELF 范围行已清除');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  console.error('套件异常终止:', e.message);
  process.exitCode = 1;
  process.exit(process.exitCode || 1);
});
