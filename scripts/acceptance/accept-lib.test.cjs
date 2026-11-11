const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('环境注入保留 Origin 并将 API 路由到独立验收面', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, origin: req.headers.origin });
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const child = spawn(process.execPath, ['-e', "const {ApiClient}=require('./accept-lib.cjs'); (async()=>{const c=new ApiClient('test'); await c.call('GET','/api/me'); await c.call('GET','/designer/');})().catch(()=>process.exitCode=1)"], {
      cwd: __dirname,
      env: { ...process.env, ACCEPT_BASE_URL: base, ACCEPT_API_PREFIX: '/accept/' },
      stdio: 'pipe',
    });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.equal(code, 0);
    assert.deepEqual(requests, [
      { url: '/accept/api/me', origin: base },
      { url: '/designer/', origin: base },
    ]);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
