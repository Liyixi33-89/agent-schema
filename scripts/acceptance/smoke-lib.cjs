/**
 * 浏览器冒烟公共辅助（三应用独立脚本共用）：
 * 页面等待、受控输入、按钮/页签点击、登录、异常判定。
 *
 * 设计原则：每个应用一个独立脚本 + 独立浏览器会话（cdp.launch/close 各自成对），
 * 避免跨应用导航导致的 SPA 冷装载竞态（同源不同路径下 hash 切换不重载 JS）。
 */
const cdp = require('./cdp.cjs');

const USERNAME = process.env.ACCEPT_USERNAME || 'accept_admin';
const PASSWORD = process.env.ACCEPT_PASSWORD || 'Accept!2026';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面可见文本。 */
async function bodyText() {
  return (await cdp.evalJs('document.body.innerText')) || '';
}

/** 轮询等待文本出现。 */
async function waitText(include, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await bodyText()).includes(include)) return true;
    await sleep(300);
  }
  return false;
}

/** 轮询等待任意一个文本出现（返回命中的那个）。 */
async function waitAnyText(candidates, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await bodyText();
    const hit = candidates.find((c) => t.includes(c));
    if (hit) return hit;
    await sleep(300);
  }
  return null;
}

/** 等输入框出现（SPA 冷装载 3.5-6s 波动——固定等待必漏判）。 */
async function waitInput(placeholderPart, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await cdp.evalJs(
      `(() => { const el = Array.from(document.querySelectorAll('input'))`
      + `.find(i => (i.placeholder || '').includes(${JSON.stringify(placeholderPart)}));`
      + ` return el ? 'yes' : 'no'; })()`,
    );
    if (r === 'yes') return true;
    await sleep(400);
  }
  return false;
}

/** 等选择器出现。 */
async function waitSelector(selector, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const n = await cdp.evalJs(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    if (n > 0) return true;
    await sleep(400);
  }
  return false;
}

/** 受控输入填值（React 原生 setter + input/change 事件）。 */
async function fillByPlaceholder(placeholderPart, value) {
  return cdp.evalJs(`(() => {
    const el = Array.from(document.querySelectorAll('input'))
      .find(i => (i.placeholder || '').includes(${JSON.stringify(placeholderPart)}));
    if (!el) return 'missing';
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
}

/** 填密码框（type=password）。 */
async function fillPassword(value) {
  return cdp.evalJs(`(() => {
    const el = Array.from(document.querySelectorAll('input')).find(i => i.type === 'password');
    if (!el) return 'missing';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
}

/** 按文本点按钮（去空白匹配——antd 中文两字按钮渲染为「登 录」）。
 *  submit 型按钮优先走 form.requestSubmit（React 受控表单下 el.click() 可能不触发 onFinish）。 */
async function clickButtonByText(text) {
  const r = await cdp.evalJs(`(() => {
    const norm = (s) => (s || '').replace(/[\\s\\u3000]+/g, '');
    const target = norm(${JSON.stringify(text)});
    const el = Array.from(document.querySelectorAll('button')).find(b => norm(b.textContent).includes(target));
    if (!el) return 'missing';
    el.scrollIntoView({ block: 'center' });
    const form = el.closest('form');
    if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(el); return 'submitted'; }
    el.click();
    return 'clicked';
  })()`);
  await sleep(800);
  return r;
}

/** 点 antd 页签（按文本）。 */
async function clickTab(name) {
  const r = await cdp.evalJs(`(() => {
    const t = Array.from(document.querySelectorAll('.ant-tabs-tab'))
      .find(x => (x.textContent || '').trim() === ${JSON.stringify(name)});
    if (!t) return 'missing';
    t.click();
    return 'ok';
  })()`);
  await sleep(1200);
  return r;
}

/** 当前可见页签列表。 */
async function tabLabels() {
  return cdp.evalJs(
    `Array.from(document.querySelectorAll('.ant-tabs-tab')).map(x => (x.textContent || '').trim())`,
  );
}

/** 等页签数量达到下限（返回标签数组，超时返回已见到的）。 */
async function waitTabs(minCount, timeoutMs = 20000) {
  const start = Date.now();
  let labels = [];
  while (Date.now() - start < timeoutMs) {
    labels = (await tabLabels()) || [];
    if (labels.length >= minCount) return labels;
    await sleep(400);
  }
  return labels;
}

/** 登录（账号 + 密码 + 提交），返回是否成功进入（由调用方给判定文案）。 */
async function login(accountPlaceholder, username = USERNAME, password = PASSWORD) {
  const ready = await waitInput(accountPlaceholder, 25000);
  if (!ready) return { ok: false, reason: '登录页未装载' };
  await fillByPlaceholder(accountPlaceholder, username);
  await fillPassword(password);
  const action = await clickButtonByText('登录');
  return { ok: action !== 'missing', action };
}

/** 真实异常（EXCEPTION: 前缀）与 antd Warning 分离。 */
function splitErrors() {
  const all = cdp.errors();
  const real = all.filter((e) => /^EXCEPTION:/.test(e)
    && !/favicon|ResizeObserver|Download the React DevTools/i.test(e));
  const warnings = all.filter((e) => /^Warning:/.test(e));
  return { real, warnings };
}

module.exports = {
  USERNAME, PASSWORD, sleep,
  bodyText, waitText, waitAnyText, waitInput, waitSelector,
  fillByPlaceholder, fillPassword, clickButtonByText, clickTab, tabLabels, waitTabs,
  login, splitErrors,
};