/**
 * M11 浏览器验收 ③：admin-console 管理端
 * 范围：成员列表与角色、用量卡片、健康、公告发布/撤下全链；普通成员越权拒绝；跨租户隔离。
 * 账号：accept_admin（org:manage）/ accept_user（普通）/ tenant2_admin（租户 2）
 * 密码经环境变量 ACCEPT_PASSWORD 传入（默认 Accept!2026 仅本地验收库）。
 */
const { BASE, ok, ApiClient, dbQuery, summary } = require('./accept-lib.cjs');
const PW = process.env.ACCEPT_PASSWORD || 'Accept!2026';

(async () => {
  const admin = new ApiClient('admin');
  const user = new ApiClient('user');
  const t2admin = new ApiClient('t2admin');

  // ---------- 1. 管理员登录 ----------
  await admin.login('API 管理员登录', 'accept_admin', PW);
  await admin.expect('API 健康检查', 'GET', '/api/ops/health', 200);
  const health = await admin.call('GET', '/api/ops/health');
  ok('健康含 DB/状态', health.json?.db === 'UP' && health.json?.status === 'UP', JSON.stringify(health.json));

  // ---------- 2. 成员列表（org:manage） ----------
  const members = await admin.expect('API 成员列表', 'GET', '/api/org/members', 200);
  const list = members.json?.list || [];
  ok('成员列表含验收账号', list.some((m) => m.account === 'accept_user') && list.some((m) => m.account === 'accept_admin'),
    JSON.stringify(list.map((m) => `${m.account}:${(m.roles || []).join(',')}`)));
  ok('成员角色真实返回', list.every((m) => Array.isArray(m.roles)), 'roles[] 结构');

  // ---------- 3. 用量卡片（登录态） ----------
  await admin.expect('API 用量卡片', 'GET', '/api/metering/usage/summary', 200);
  const usage = await admin.call('GET', '/api/metering/usage/summary');
  ok('用量卡片结构', usage.json && typeof usage.json === 'object', JSON.stringify(usage.json).slice(0, 160));

  // ---------- 4. 公告发布/生效/撤下全链 ----------
  const noticeTitle = `验收公告-${Date.now().toString(36)}`;
  await admin.expect('API 公告发布', 'POST', '/api/ops/notices', 200, { title: noticeTitle, content: 'M11 验收公告内容', level: 'WARNING' });
  const active = await admin.call('GET', '/api/ops/notices/active');
  ok('生效公告即所发', active.json?.notice?.title === noticeTitle && active.json?.notice?.level === 'WARNING',
    JSON.stringify(active.json));
  // DB 落库核对
  const dbRow = dbQuery(`SELECT title, level, active FROM ops_notice WHERE title='${noticeTitle}'`);
  ok('公告落库核对', dbRow.length === 1 && dbRow[0].includes('WARNING') && dbRow[0].endsWith('|t'), JSON.stringify(dbRow));
  await admin.expect('API 公告撤下', 'PUT', '/api/ops/notices/deactivate', 200);
  const afterDeactivate = await admin.call('GET', '/api/ops/notices/active');
  ok('撤下后无生效公告', !afterDeactivate.json?.notice?.title, JSON.stringify(afterDeactivate.json));

  // ---------- 5. 普通成员越权拒绝 ----------
  await user.login('API 普通成员登录', 'accept_user', PW);
  const denied1 = await user.call('GET', '/api/org/members');
  ok('普通成员拉成员清单被拒(403)', denied1.status === 403, `HTTP ${denied1.status}`);
  const denied2 = await user.call('POST', '/api/ops/notices', { title: 'x', content: 'x' });
  ok('普通成员发公告被拒(403)', denied2.status === 403, `HTTP ${denied2.status}`);
  const denied3 = await user.call('GET', '/api/ops/notices');
  ok('普通成员看公告历史被拒(403)', denied3.status === 403, `HTTP ${denied3.status}`);
  // 登录态接口不拦（运行时横幅可读）
  const allowedNotice = await user.call('GET', '/api/ops/notices/active');
  ok('普通成员可读生效公告(200)', allowedNotice.status === 200, `HTTP ${allowedNotice.status}`);

  // ---------- 6. 跨租户隔离 ----------
  // 匿名登录默认租户 1（TenantContextFilter）——租户 2 账号须显式传 tenantId
  const t2login = await t2admin.call('POST', '/api/auth/login', { username: 'accept_t2', password: PW, tenantId: 2 });
  if (t2login.status !== 200) {
    ok('API 租户2用户登录', false, `HTTP ${t2login.status}: ${t2login.raw.slice(0, 120)}`);
  } else {
    ok('API 租户2用户登录::凭证三件套', t2admin.cookies.has('schema_at') && t2admin.cookies.has('schema_rt'),
      `at=${t2admin.cookies.has('schema_at')} rt=${t2admin.cookies.has('schema_rt')}`);
  }
  const t2members = await t2admin.call('GET', '/api/org/members');
  ok('租户2无权拉成员清单(403)', t2members.status === 403, `HTTP ${t2members.status}`);
  const t2notice = await t2admin.call('GET', '/api/ops/notices/active');
  ok('租户2公告空间独立(200且非租户1公告)', t2notice.status === 200 && t2notice.json?.notice?.title !== noticeTitle,
    JSON.stringify(t2notice.json).slice(0, 120));
  // 租户 2 不得看到租户 1 的应用
  const t2apps = await t2admin.call('GET', '/api/apps');
  ok('租户2应用列表隔离', t2apps.status === 200 && !(JSON.stringify(t2apps.json || {}).includes('"报销管理"')),
    JSON.stringify(t2apps.json).slice(0, 140));
  // 租户 1 的凭证不得访问租户 2 资源（伪造租户头——审计 TENANT_MISMATCH 路径）
  const forged = await t2admin.call('GET', '/api/apps', null, { 'X-Tenant-Id': '1' });
  ok('伪造租户头被拒或按 JWT 租户判定', forged.status !== 200 || !(JSON.stringify(forged.json || {}).includes('报销管理')),
    `HTTP ${forged.status} body=${JSON.stringify(forged.json || {}).slice(0, 100)}`);

  summary('admin-console');
})().catch((e) => {
  console.error('FATAL:', e.message);
  summary('admin-console');
  process.exitCode = 1;
});
