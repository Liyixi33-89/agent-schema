/**
 * M11 浏览器验收 CDP 驱动（零依赖）：Chrome headless + 原生 WebSocket
 * 能力：导航、等待选择器、截图、点击、输入、读文本、执行 JS、读 console 错误
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const OUT_DIR = process.env.ACCEPT_RUN_DIR || path.join(__dirname, 'out');
const SHOT_DIR = path.join(OUT_DIR, process.env.ACCEPT_RUN_ID ? path.join('shots', process.env.ACCEPT_SUITE || 'default') : 'shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let browser = null;
let ws = null;
const allBrowsers = [];       // 全部已启动 Chrome 进程（多次 launch 时 close 逐一清理）
const allSockets = [];       // 全部已建立 WS 连接（泄漏的 WS 会保持事件循环存活——挂起根因）
let msgId = 0;
const pending = new Map();       // id -> {resolve, reject}
const consoleErrors = [];        // 页面 console.error / 未捕获异常
let runtimeEnabled = false;      // Runtime 域启用标记（未启用则 console 事件不推送——恒空假 PASS）
let logEnabled = false;          // Log 域启用标记（浏览器级消息：XFO/frame-ancestors 拒绝等）
const browserLogEntries = [];    // Log.entryAdded 采集（拒绝嵌入/拦截类浏览器级证据）
let screenshotCount = 0;
let profileDir = null;           // 本轮独立 profile（会话隔离——禁止跨轮残留 Cookie）

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => resolve(d)); })
      .on('error', reject);
  });
}

async function launch(url = 'about:blank') {
  // 每轮独立 profile：时间戳目录，close 时删除（同轮内 goto 保持同一上下文）
  profileDir = path.join(OUT_DIR, 'private', process.env.ACCEPT_SUITE || 'direct', `chrome-profile-${Date.now()}`);
  fs.mkdirSync(profileDir, { recursive: true });
  // 公网验收豁免（仅验收轮）：平台会话 cookie 强制 Secure（03BE 生产强制 HTTPS 前提），
  // 纯 HTTP 公网 IP 下浏览器拒存——--unsafely-treat-insecure-origin-as-secure 解锁存储；
  // 该 flag 只影响验收 Chrome 的 cookie 存储策略，不改变服务端任何安全语义。
  const insecureOrigin = process.env.ACCEPT_ALLOW_INSECURE_ORIGIN || '';
  const extraArgs = insecureOrigin
    ? ['--unsafely-treat-insecure-origin-as-secure=' + insecureOrigin] : [];
  browser = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-cache',           // 每轮验收强制拉最新产物
    '--disk-cache-size=1',
    '--window-size=1440,900',
    '--user-data-dir=' + profileDir,
    '--remote-allow-origins=*',
    ...extraArgs,
    'about:blank',
  ], { stdio: 'ignore' });
  allBrowsers.push(browser);
  // 重启后域启用状态归零（新浏览器实例须重新 enable）
  runtimeEnabled = false;
  logEnabled = false;
  // 等 CDP 就绪
  for (let i = 0; i < 30; i++) {
    try {
      const ver = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/version`));
      const targets = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`));
      const page = targets.find((t) => t.type === 'page');
      await connect(page.webSocketDebuggerUrl);
      // 连接即启用 Runtime/Log 域：console 错误与浏览器级消息（XFO 拒绝等）默认采集，
      // 免得每个套件各自记得调 ensure——漏调即恒空假 PASS（M15 收口修复）。
      await send('Runtime.enable');
      await send('Log.enable');
      runtimeEnabled = true;
      logEnabled = true;
      return;
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('Chrome CDP 未就绪');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    allSockets.push(ws);
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(new Error('WS error: ' + e.message));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === 'Network.requestWillBeSent' && networkCapture) {
        networkCapture.requests.push({ requestId: msg.params.requestId, url: msg.params.request.url,
          method: msg.params.request.method, postData: msg.params.request.postData, status: null, done: false });
      } else if (msg.method === 'Network.responseReceived' && networkCapture) {
        const r = networkCapture.requests.find((x) => x.requestId === msg.params.requestId);
        if (r) r.status = msg.params.response.status;
      } else if (msg.method === 'Network.loadingFinished' && networkCapture) {
        const r = networkCapture.requests.find((x) => x.requestId === msg.params.requestId);
        if (r) r.done = true;
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push('EXCEPTION: ' + (msg.params.exceptionDetails?.exception?.description
          ?? msg.params.exceptionDetails?.text ?? 'unknown'));
      } else if (msg.method === 'Log.entryAdded' && logEnabled) {
        const e = msg.params.entry || {};
        // 只采集与页面相关的浏览器级消息（network/error 来源），避免噪声淹没
        if (['network', 'error', 'security'].includes(String(e.source))) {
          browserLogEntries.push(`${e.source}/${e.level}: ${e.text || ''} ${e.url || ''}`.trim());
        }
      }
    };
  });
}

/** CDP 网络域捕获（不经页面 JS——React fetch 闭包捕获不影响，天然覆盖全部请求）。 */
let networkCapture = null;
async function startNetwork() {
  networkCapture = { requests: [] };
  await send('Network.enable');
}
function networkRequests() { return networkCapture ? networkCapture.requests : []; }
function stopNetwork() { networkCapture = null; }


function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** 打开 URL 并等加载完成。 */
async function goto(url) {
  await send('Page.enable');
  await send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 1200)); // SPA 初载
}

/** Runtime 域显式启用（幂等）：console.error / 未捕获异常事件依赖此域推送——
 *  未启用时 errors() 恒空，console 断言会假 PASS（M15 收口修复）。 */
async function ensureRuntime() {
  if (!runtimeEnabled) {
    await send('Runtime.enable');
    runtimeEnabled = true;
  }
}

/** Log 域显式启用（幂等）：浏览器级消息（XFO/frame-ancestors 拒绝、网络失败）采集前提。 */
async function ensureLog() {
  if (!logEnabled) {
    await send('Log.enable');
    logEnabled = true;
  }
}

/** 浏览器级日志读取（XFO 拒绝嵌入证据通道）。 */
function browserLog() { return [...browserLogEntries]; }
function resetBrowserLog() { browserLogEntries.length = 0; }

/** 强制重载（同 hash 路由下 Page.navigate 不触发重载——登出后会话失效验证必需）。 */
async function reload() {
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: false });
  await new Promise((r) => setTimeout(r, 1500));
}

/** 等选择器出现（默认 8s 超时）。 */
async function waitFor(selector, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await send('Runtime.evaluate', {
      expression: `!!document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: true,
    });
    if (r.result.value === true) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`等待选择器超时: ${selector}`);
}

/** 执行 JS 表达式取值。 */
async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval 异常: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
}

/** 读元素文本（可多次匹配拼接）。 */
async function text(selector) {
  return evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent : null; })()`);
}

async function texts(selector) {
  return evalJs(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(e => e.textContent.trim())`);
}

/** 点击元素（真实事件派发）。 */
async function click(selector) {
  await waitFor(selector);
  await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); })()`);
  await new Promise((r) => setTimeout(r, 400));
}

/** antd Input 填值（react 受控组件须用原生 setter 触发 onChange）。 */
async function fill(selector, value) {
  await waitFor(selector);
  await evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
}

/** 真实鼠标点击（CDP Input 域——React 合成事件可靠触发，绕过 eval 事件模拟问题）。 */
async function mouseClick(selector) {
  await waitFor(selector);
  const box = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
    const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`);
  const { x, y } = JSON.parse(box);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 500));
}

/** 元素中心点（供真实输入路径取坐标）。 */
async function centerOf(selectorExpr) {
  const box = await evalJs(`(() => { const el = ${selectorExpr}; if (!el) return null;
    const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`);
  return box ? JSON.parse(box) : null;
}

/**
 * 真实鼠标拖拽（CDP Input.dispatchMouseEvent 逐帧序列）：
 * press → 中间路径多帧 move（带插值坐标）→ release。
 * 事件由浏览器输入管线合成（isTrusted=true），走浏览器原生命中测试，
 * 不依赖页面 JS 派发。适用于 mousedown/mousemove/mouseup 驱动的交互（点击选择、
 * 大纲拖拽等）。注意：HTML5 draggable 源的 dragstart 由浏览器在阈值后启动，
 * headless 下该路径是否触发 dragstart 需在验收现场实测确认（见 race 套件 C2 双形态）。
 */
async function mouseDrag(x1, y1, x2, y2, opts = {}) {
  const steps = opts.steps || 12;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = x1 + (x2 - x1) * i / steps;
    const y = y1 + (y2 - y1) * i / steps;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left' });
    await new Promise((r) => setTimeout(r, opts.frameMs ?? 30));
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 400));
}

/** React 合成事件直调（evaluate 内 .click() 的合成事件不被 React 分发的兜底）。 */
async function clickReact(selector) {
  await waitFor(selector);
  return evalJs('(() => { const el = document.querySelector(' + JSON.stringify(selector) + ');'
    + ' const fiberKey = Object.keys(el).find(k => k.startsWith("__reactFiber$"));'
    + ' if (!fiberKey) return "no-fiber";'
    + ' const onClick = el[fiberKey].memoizedProps && el[fiberKey].memoizedProps.onClick;'
    + ' if (typeof onClick !== "function") return "no-onClick";'
    + ' onClick({ preventDefault() {}, stopPropagation() {} });'
    + ' return "invoked"; })()');
}

/** 截图存档。 */
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(SHOT_DIR, `${String(++screenshotCount).padStart(2, '0')}-${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

/** 清会话态（退出登录态验证用）。 */
async function clearStorage() {
  await evalJs(`localStorage.clear(); sessionStorage.clear();`);
}

function errors() { return consoleErrors; }
function resetErrors() { consoleErrors.length = 0; }
async function close() {
  try { ws?.close(); } catch {}
  try { browser?.kill(); } catch {}
  // 多轮 launch 场景：逐一清理全部实例（泄漏的 WS/进程会保持事件循环存活——套件挂起根因）
  for (const s of allSockets.splice(0)) { try { s.close(); } catch {} }
  for (const b of allBrowsers.splice(0)) { try { b.kill(); } catch {} }
  // 等进程退出后清理本轮临时 profile（隔离证据——不留跨轮会话态）
  if (profileDir) {
    const dir = profileDir;
    profileDir = null;
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 2000);
  }
}

module.exports = { launch, goto, reload, waitFor, evalJs, text, texts, click, fill, mouseClick, mouseDrag, centerOf, clickReact, shot, clearStorage, errors, resetErrors, close, PORT, startNetwork, networkRequests, stopNetwork, send, ensureRuntime, ensureLog, browserLog, resetBrowserLog };
