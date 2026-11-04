'use strict';
const assert = require('node:assert/strict');
const { Browser } = require('./browser.cjs');
const base = process.env.ACCEPT_BASE_URL || 'http://127.0.0.1:8090';

(async () => {
  assert.ok(process.env.ACCEPT_USERNAME && process.env.ACCEPT_PASSWORD, '请提供验收账号环境变量');
  const browser = new Browser();
  try {
    await browser.launch();
    await browser.goto(base + '/designer/');
    await browser.fill('input[placeholder="账号"]', process.env.ACCEPT_USERNAME);
    await browser.fill('input[placeholder="密码"]', process.env.ACCEPT_PASSWORD);
    await browser.click('button[type="submit"]');
    await browser.wait(() => browser.evaluate('!!document.querySelector(".ant-layout-header")'), '登录进入工作台');
    await browser.goto(base + '/#/app/1');
    await browser.click('.ant-menu-submenu-title');
    await browser.wait(() => browser.evaluate('Array.from(document.querySelectorAll(".ant-menu-item")).some(e => e.textContent.includes("报销登记"))'), '页面菜单出现');
    await browser.evaluate('Array.from(document.querySelectorAll(".ant-menu-item")).find(e => e.textContent.includes("报销登记")).setAttribute("data-accept-page", "1")');
    await browser.click('[data-accept-page]');
    await browser.wait(() => browser.evaluate('document.querySelectorAll(".ant-form-item").length === 4'), '四字段渲染');
    const stamp = 'M11-' + Date.now();
    await browser.fill('.ant-form-item:nth-of-type(1) input', stamp);
    await browser.fill('.ant-form-item:nth-of-type(2) input', '88');
    await browser.evaluate('Array.from(document.querySelectorAll("button")).find(b => b.parentElement.classList.contains("ant-card-body") && b.textContent.replace(/\\s/g," ").includes("交")).setAttribute("data-accept-submit", "1")');
    const started = new Set(browser.requests.keys());
    await browser.click('[data-accept-submit]');
    let write;
    await browser.wait(() => {
      write = [...browser.requests.values()].find(r => !started.has(r.id) && r.method === 'POST' && new URL(r.url).pathname === '/api/data/1' && r.finished);
      return !!write;
    }, '真实点击触发写入请求');
    const payload = JSON.parse(write.postData);
    assert.equal(payload.title, stamp);
    assert.equal(Number(payload.amount), 88);
    assert.equal(write.status, 200);
    const response = await browser.body(write);
    assert.ok(response.id || response.recordId, '写入返回新记录 ID');
    console.log(JSON.stringify({ passed: true, stamp, request: { method: write.method, status: write.status, payload }, response }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
