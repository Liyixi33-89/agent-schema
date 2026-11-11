/**
 * M14 G7 前置：脚本 API 注册名代理通道验证（Node 侧）
 * - 登录后 /api/scripts/apis/{name} 真实返回数据（非 mock）
 * - 未注册名 422 API_NOT_REGISTERED；无凭证 401；畸形 params 按缺省分页
 */
const path = require('path');
const { ApiClient } = require('./accept-lib.cjs');

async function main() {
  const client = new ApiClient('g7-api');
  await client.login('登录验收账号', process.env.ACCEPT_USERNAME || 'accept_user', process.env.ACCEPT_PASSWORD || 'Accept!2026');

  const reg = await client.call('GET', '/api/scripts/apis');
  const names = reg.json && reg.json.names;
  if (!Array.isArray(names) || !names.includes('expense-records')) {
    throw new Error(`注册表异常: ${reg.raw.slice(0, 200)}`);
  }
  console.log('PASS  注册名清单含 expense-records');

  const anon = await client.constructor === ApiClient ? null : null; // 占位（匿名验证独立连接）
  const r1 = await client.call('GET', '/api/scripts/apis/expense-records?params=' + encodeURIComponent(JSON.stringify({ page: 1, size: 5 })));
  if (r1.status !== 200 || !r1.json || !Array.isArray(r1.json.list)) {
    throw new Error(`注册名查询异常: HTTP ${r1.status} ${r1.raw.slice(0, 200)}`);
  }
  console.log(`PASS  expense-records 查询返回 list=${r1.json.list.length} total=${r1.json.total}`);

  const r2 = await client.call('GET', '/api/scripts/apis/not-registered');
  if (r2.status !== 422 || !String(r2.raw).includes('API_NOT_REGISTERED')) {
    throw new Error(`未注册名应 422: HTTP ${r2.status} ${r2.raw.slice(0, 200)}`);
  }
  console.log('PASS  未注册名 422 API_NOT_REGISTERED');

  const r3 = await client.call('GET', '/api/scripts/apis/expense-records?params=' + encodeURIComponent('{bad json'));
  if (r3.status !== 200) {
    throw new Error(`畸形 params 应按缺省 200: HTTP ${r3.status} ${r3.raw.slice(0, 200)}`);
  }
  console.log('PASS  畸形 params 按缺省分页返回 200');

  // 无凭证独立验证
  const http = require('http');
  await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:8090/api/scripts/apis/expense-records', (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if (res.statusCode === 401) { console.log('PASS  无凭证访问 401'); resolve(); }
        else reject(new Error(`无凭证应 401 实得 ${res.statusCode}: ${d.slice(0, 120)}`));
      });
    });
  });

  console.log('SUMMARY g7-api-channel: ALL PASS');
}

main().catch((e) => { console.error('FAIL  g7-api-channel:', e.message); process.exit(1); });
