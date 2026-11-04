'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

class Browser {
  constructor() {
    this.pending = new Map();
    this.requests = new Map();
    this.errors = [];
    this.sequence = 0;
  }

  async launch() {
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-accept-'));
    this.process = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
      '--headless=new', '--remote-debugging-port=0', '--no-first-run',
      '--no-default-browser-check', '--window-size=1440,900',
      '--user-data-dir=' + this.profile, 'about:blank',
    ], { stdio: 'ignore' });
    const active = path.join(this.profile, 'DevToolsActivePort');
    await this.wait(() => fs.existsSync(active), 'Chrome 独立调试端口');
    const port = fs.readFileSync(active, 'utf8').split('\n')[0];
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find(t => t.type === 'page');
    assert.ok(page, '独立 Chrome 页面存在');
    this.socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    });
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
      } else if (message.method === 'Network.requestWillBeSent') {
        const p = message.params;
        this.requests.set(p.requestId, { id: p.requestId, url: p.request.url,
          method: p.request.method, postData: p.request.postData });
      } else if (message.method === 'Network.responseReceived') {
        const p = message.params;
        const request = this.requests.get(p.requestId);
        if (request) Object.assign(request, { status: p.response.status, mimeType: p.response.mimeType });
      } else if (message.method === 'Network.loadingFinished') {
        const request = this.requests.get(message.params.requestId);
        if (request) request.finished = true;
      } else if (message.method === 'Network.loadingFailed') {
        const request = this.requests.get(message.params.requestId);
        if (request) request.error = message.params.errorText;
      } else if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params.exceptionDetails.text);
      }
    };
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  async wait(predicate, name, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`等待失败: ${name}`);
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
  }

  async click(selector) {
    await this.wait(() => this.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), selector);
    const box = await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'center' });
      const r = element.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
    })()`);
    assert.ok(box.width > 0 && box.height > 0, '点击目标可见');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
  }

  async fill(selector, text) {
    await this.click(selector);
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await this.send('Input.insertText', { text: String(text) });
    await this.wait(() => this.evaluate(`document.querySelector(${JSON.stringify(selector)}).value === ${JSON.stringify(String(text))}`), '输入值回读');
  }

  async body(request) {
    const result = await this.send('Network.getResponseBody', { requestId: request.id });
    return JSON.parse(result.base64Encoded ? Buffer.from(result.body, 'base64').toString() : result.body);
  }

  async close() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      try { await this.send('Browser.close'); } catch {}
      this.socket.close();
    }
    // 临时 profile 留给系统清理；不复用，不影响下一轮会话。
  }
}
module.exports = { Browser };
