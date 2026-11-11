/**
 * M14 G7 前置：脚本 API 注册名代理通道验证（Node 侧）
 * - 登录后 /api/scripts/apis/{name} 真实返回数据（非 mock）
 * - 未注册名 422 API_NOT_REGISTERED；无凭证 401；畸形 params 按缺省分页
 */
const path = require('path');
const { ApiClient, ok, summary } = require('./accept-lib.cjs');

async function main() {
  const client = new ApiClient('g7-api');
  await client.login('登录验收账号', process.env.ACCEPT_USERNAME || 'accept_user', process.env.ACCEPT_PASSWORD || 'Accept!2026');

  const reg = await client.call('GET', '/api/scripts/apis');
  const names = reg.json && reg.json.names;
  ok('API-注册名清单含 expense-records', Array.isArray(names) && names.includes('expense-records'),
    Array.isArray(names) ? names.join(',') : reg.raw.slice(0, 140));

  const r1 = await client.call('GET', '/api/scripts/apis/expense-records?params=' + encodeURIComponent(JSON.stringify({ page: 1, size: 5 })));
  ok('API-expense-records 查询真实返回数据（非 mock）', r1.status === 200 && !!(r1.json && Array.isArray(r1.json.list)),
    r1.status === 200 && r1.json ? `list=${r1.json.list.length} total=${r1.json.total}` : `HTTP ${r1.status} ${r1.raw.slice(0, 140)}`);

  const r2 = await client.call('GET', '/api/scripts/apis/not-registered');
  ok('API-未注册名 422 API_NOT_REGISTERED', r2.status === 422 && String(r2.raw).includes('API_NOT_REGISTERED'),
    `HTTP ${r2.status}`);

  const r3 = await client.call('GET', '/api/scripts/apis/expense-records?params=' + encodeURIComponent('{bad json'));
  ok('API-畸形 params 按缺省分页返回 200（负例容错）', r3.status === 200,
    `HTTP ${r3.status}${r3.status !== 200 ? ' ' + r3.raw.slice(0, 140) : ''}`);

  // 无凭证独立验证
  const http = require('http');
  const anon = await new Promise((resolve) => {
    http.get('http://127.0.0.1:8090/api/scripts/apis/expense-records', (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 120) }));
    });
  });
  ok('API-无凭证访问 401（token 隔离）', anon.status === 401,
    `HTTP ${anon.status}${anon.status !== 401 ? ' ' + anon.body : ''}`);

  summary('g7-api');
}

main().catch((e) => { console.error('FAIL  g7-api:', e.message); process.exit(1); });
