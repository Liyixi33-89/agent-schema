/**
 * 三应用冒烟统一入口：串行执行 designer / runtime / admin 三个独立脚本，
 * 每个脚本各自 launch/close 浏览器（独立会话，互不干扰）。
 *
 * 用法：
 *   node scripts/acceptance/smoke-all.cjs
 *
 * 环境：
 *   ACCEPT_BASE_URL            目标站点（默认 http://127.0.0.1:8090）
 *   ACCEPT_API_PREFIX          API 前缀（验收面 /accept）
 *   ACCEPT_ALLOW_INSECURE_ORIGIN  HTTP 下 Secure Cookie 豁免源（逗号分隔）
 *   SMOKE_DESIGNER/RUNTIME/ADMIN  三应用地址（默认回落 ACCEPT_BASE_URL）
 *   ACCEPT_USERNAME/PASSWORD   账号（默认 accept_admin / Accept!2026）
 *   ACCEPT_RUN_DIR             结果输出目录
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SUITES = [
  { name: 'designer', file: 'smoke-designer.cjs' },
  { name: 'runtime', file: 'smoke-runtime.cjs' },
  { name: 'admin', file: 'smoke-admin.cjs' },
];

const results = [];
for (const s of SUITES) {
  const file = path.join(__dirname, s.file);
  console.log(`\n${'='.repeat(60)}\n== ${s.name} ==\n${'='.repeat(60)}`);
  const r = spawnSync(process.execPath, [file], {
    stdio: 'inherit',
    env: { ...process.env, ACCEPT_SUITE: `smoke-${s.name}` },
  });
  results.push({ name: s.name, code: r.status ?? 1 });
}

console.log(`\n${'='.repeat(60)}\n== 汇总 ==\n${'='.repeat(60)}`);
for (const r of results) {
  console.log(`${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.name}`);
}
const failed = results.filter((r) => r.code !== 0);
if (failed.length) {
  console.error(`\n${failed.length}/${results.length} 套件失败`);
  process.exitCode = 1;
} else {
  console.log(`\n${results.length}/${results.length} 套件全部通过`);
}