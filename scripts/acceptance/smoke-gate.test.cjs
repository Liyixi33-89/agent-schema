/**
 * 冒烟门禁自测（P0：消除假绿）。
 *
 * 不跑真实浏览器——用合成 stats/result 文件驱动 smoke-all 的门禁逻辑，
 * 验证「缺统计 / 零用例 / 必跑跳过 / 汇总缺失」四类假绿都会变红。
 *
 * 做法：把三套件脚本替换为「只写统计文件」的桩脚本，
 * 通过环境变量控制写什么，然后运行 smoke-all 并断言退出码。
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const SMOKE_ALL = path.join(REPO, 'scripts', 'acceptance', 'smoke-all.cjs');

/** 桩套件脚本：按环境变量写入 stats，模拟各种异常场景。 */
const STUB = `
const fs = require('node:fs');
const path = require('node:path');
const suite = process.env.ACCEPT_SUITE;          // smoke-designer / smoke-runtime / smoke-admin
const mode = process.env.STUB_MODE || 'ok';      // ok | fail | empty | missing
const dir = process.env.ACCEPT_RUN_DIR;
fs.mkdirSync(dir, { recursive: true });
const name = suite.replace(/^smoke-/, '');
if (mode === 'missing') { process.exit(0); }     // 不写统计（模拟脚本异常/未执行）
const expected = mode === 'empty' ? 0 : 3;
const passed = mode === 'fail' ? 2 : expected;
const failed = mode === 'fail' ? 1 : 0;
fs.writeFileSync(path.join(dir, suite + '-stats.json'), JSON.stringify({
  suite, kind: 'browser-smoke',
  expected, executed: expected, passed, failed, skipped: 0, requiredSkipped: 0,
}));
process.exit(mode === 'fail' ? 1 : 0);
`;

function runCase(label, env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-gate-'));
  const stubDir = path.join(tmp, 'suites');
  fs.mkdirSync(stubDir, { recursive: true });
  for (const n of ['designer', 'runtime', 'admin']) {
    fs.writeFileSync(path.join(stubDir, `smoke-${n}.cjs`), STUB);
  }
  const out = path.join(tmp, 'out');
  const r = spawnSync(process.execPath, [SMOKE_ALL], {
    env: { ...process.env, ...env, ACCEPT_RUN_DIR: out, SMOKE_SUITE_DIR: stubDir },
    encoding: 'utf8',
  });
  const combined = (r.stdout || '') + (r.stderr || '');
  return { label, code: r.status ?? 1, output: combined, out };
}

const cases = [
  { label: '全部正常 → 应 PASS', env: { STUB_MODE: 'ok' }, expectFail: false },
  { label: '某套件统计缺失 → 应 FAIL', env: { STUB_MODE: 'missing' }, expectFail: true },
  { label: '全部零用例 → 应 FAIL', env: { STUB_MODE: 'empty' }, expectFail: true },
  { label: '某套件断言失败 → 应 FAIL', env: { STUB_MODE: 'fail' }, expectFail: true },
];

console.log('=== 冒烟门禁自测 ===\n');
let bad = 0;
for (const c of cases) {
  const r = runCase(c.label, c.env);
  const failedAsExpected = c.expectFail ? r.code !== 0 : r.code === 0;
  const verdict = failedAsExpected ? 'OK' : 'UNEXPECTED';
  console.log(`[${verdict}] ${c.label} (exit=${r.code})`);
  if (!failedAsExpected) {
    bad += 1;
    console.log('--- output ---');
    console.log(r.output.slice(0, 1200));
  } else if (c.expectFail) {
    // 失败时确认给出了可读原因（不是无声退出）
    const hasReason = /门禁失败|套件统计缺失|零场景|必验项被跳过|expected=0|矛盾|套件失败/.test(r.output);
    console.log(`  原因可读: ${hasReason ? 'YES' : 'NO'}`);
    if (!hasReason) bad += 1;
  }
  fs.rmSync(path.dirname(r.out), { recursive: true, force: true });
}

console.log(`\n结果：${cases.length - bad}/${cases.length} 通过`);
process.exitCode = bad === 0 ? 0 : 1;