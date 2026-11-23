/**
 * 三应用冒烟统一入口：串行执行 designer / runtime / admin 三个独立脚本，
 * 每个脚本各自 launch/close 浏览器（独立会话，互不干扰）。
 *
 * 第二阶段：汇总三类统计（expected/executed/passed/failed/skipped），
 * 关联被测 SHA / 运行编号 / 环境，产出 smoke-summary.json 供 CI 归档与门禁消费。
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
 *   GIT_COMMIT / GITHUB_RUN_ID 关联信息（CI 自动注入）
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SUITES = [
  { name: 'designer', file: 'smoke-designer.cjs' },
  { name: 'runtime', file: 'smoke-runtime.cjs' },
  { name: 'admin', file: 'smoke-admin.cjs' },
];

const RUN_DIR = process.env.ACCEPT_RUN_DIR || path.join(__dirname, 'out');
fs.mkdirSync(RUN_DIR, { recursive: true });

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

// 第二阶段：聚合三套件统计（各套件的 -stats.json 由 accept-lib.summary 写出）
const suites = [];
for (const s of SUITES) {
  const p = path.join(RUN_DIR, `smoke-${s.name}-stats.json`);
  if (fs.existsSync(p)) {
    try { suites.push(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch { /* 忽略解析失败，下面会判缺失 */ }
  }
}
const agg = { kind: 'browser-smoke', expected: 0, executed: 0, passed: 0, failed: 0, skipped: 0, requiredSkipped: 0 };
for (const s of suites) {
  agg.expected += s.expected ?? 0;
  agg.executed += s.executed ?? 0;
  agg.passed += s.passed ?? 0;
  agg.failed += s.failed ?? 0;
  agg.skipped += s.skipped ?? 0;
  agg.requiredSkipped += s.requiredSkipped ?? 0;
}
const summary = {
  ...agg,
  suiteCount: suites.length,
  expectedSuiteCount: SUITES.length,
  commit: process.env.GIT_COMMIT || process.env.VERIFY_COMMIT || null,
  runId: process.env.GITHUB_RUN_ID || null,
  baseUrl: process.env.ACCEPT_BASE_URL || null,
  chrome: process.env.CHROME_PATH || null,
  finishedAt: new Date().toISOString(),
  suites: results,
};
fs.writeFileSync(path.join(RUN_DIR, 'smoke-summary.json'), JSON.stringify(summary, null, 2));
console.log(`\n[stats] ${JSON.stringify({ ...agg, suiteCount: suites.length })}`);

const failed = results.filter((r) => r.code !== 0);
let exitCode = 0;
if (failed.length) {
  console.error(`\n${failed.length}/${results.length} 套件失败`);
  exitCode = 1;
} else {
  console.log(`\n${results.length}/${results.length} 套件全部通过`);
}

// 第二阶段门禁：零场景执行 / 统计缺失 / 必验项跳过 → 失败
if (suites.length === 0) {
  console.error('冒烟统计缺失：未产出任何 -stats.json（脚本未正常收尾）');
  exitCode = 1;
} else if (agg.expected === 0) {
  console.error('冒烟零场景：expected=0（必验项不得空跑）');
  exitCode = 1;
} else if (agg.requiredSkipped > 0) {
  console.error(`必验项被跳过 ${agg.requiredSkipped} 个`);
  exitCode = 1;
} else if (suites.length < SUITES.length) {
  console.error(`统计不完整：${suites.length}/${SUITES.length} 套件有统计`);
  exitCode = 1;
}

process.exitCode = exitCode;