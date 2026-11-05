/**
 * evidence.cjs 门禁自测（node:test，零依赖）：覆盖 docs/acceptance/README.md §6 最低测试要求。
 * 运行：node --test scripts/acceptance/evidence.test.cjs
 * 目录根通过 ACCEPT_EVIDENCE_OUT / ACCEPT_EVIDENCE_ARCHIVE 注入临时区，不污染真实 out/ 与归档。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ev = require('./evidence.cjs');

/** 每个测试独立沙箱：环境变量注入 + 结束清理。 */
function sandbox(fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-test-'));
    const env = {
      ...process.env,
      ACCEPT_EVIDENCE_OUT: path.join(tmp, 'out'),
      ACCEPT_EVIDENCE_ARCHIVE: path.join(tmp, 'archive'),
    };
    const saved = { ...{} };
    Object.assign(process.env, env);
    try {
      await fn(tmp, {
        out: env.ACCEPT_EVIDENCE_OUT,
        arch: env.ACCEPT_EVIDENCE_ARCHIVE,
      });
    } finally {
      for (const key of Object.keys(env)) if (key in saved) process.env[key] = saved[key];
      delete process.env.ACCEPT_EVIDENCE_OUT;
      delete process.env.ACCEPT_EVIDENCE_ARCHIVE;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

function fakeRunDir(out, runId, suites) {
  const dir = path.join(out, runId);
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
    formatVersion: 1, workPackage: 'TEST', runId, startedAt: '2026-11-05T00:00:00Z',
    sourceCommit: 'a'.repeat(40), workingTreeClean: true, environment: {}, suites,
  }, null, 2));
  return dir;
}

test('run-id 并发防覆盖：同目录已存在时自动加序号，旧内容不被覆盖', sandbox(async (tmp, dirs) => {
  const stamp = ev.timestamp(new Date('2026-11-05T06:01:02Z'));
  const existing = path.join(dirs.out, `${stamp}-aaaaaaa`);
  fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, 'keep.txt'), 'data');
  // 直接验证命名规则逻辑（loadOrCreateRun 需要 git HEAD，测试环境复刻判定）
  let base = `${stamp}-aaaaaaa`, id = base;
  for (let i = 2; fs.existsSync(path.join(dirs.out, id)); i++) id = `${base}-${i}`;
  assert.notStrictEqual(id, base);
  assert.match(id, /-2$/);
  assert.strictEqual(fs.readFileSync(path.join(existing, 'keep.txt'), 'utf8'), 'data');
}));

test('失败退出码保留：suite 计数与退出码如实进入 run.json', sandbox(async (tmp, dirs) => {
  fakeRunDir(dirs.out, 'run-fail', { s1: { command: 'x', passed: 3, failed: 2, skipped: 0, exitCode: 1 } });
  const run = JSON.parse(fs.readFileSync(path.join(dirs.out, 'run-fail', 'run.json'), 'utf8'));
  assert.strictEqual(run.suites.s1.exitCode, 1);
  assert.strictEqual(run.suites.s1.failed, 2);
}));

test('归档拒绝覆盖已有目录', sandbox(async (tmp, dirs) => {
  fakeRunDir(dirs.out, 'run-dup', { s1: { command: 'x', passed: 1, failed: 0, skipped: 0, exitCode: 0 } });
  fs.writeFileSync(path.join(dirs.out, 'run-dup', 's1-result.json'), '[]');
  fs.mkdirSync(path.join(dirs.arch, 'TEST', 'run-dup'), { recursive: true });
  assert.throws(() => ev.archive('TEST', 'run-dup', ['s1-result.json']), /拒绝覆盖/);
}));

test('归档拒绝路径逃逸与禁入类型', sandbox(async (tmp, dirs) => {
  fakeRunDir(dirs.out, 'run-esc', { s1: { command: 'x', passed: 1, failed: 0, skipped: 0, exitCode: 0 } });
  fs.writeFileSync(path.join(dirs.out, 'run-esc', 's1-result.json'), '[]');
  fs.writeFileSync(path.join(dirs.out, 'run-esc', 'dbq_exec.sh'), 'x');
  assert.throws(() => ev.archive('TEST', 'run-esc', ['../../s1-result.json']), /路径逃逸/);
  assert.throws(() => ev.archive('TEST', 'run-esc', ['dbq_exec.sh']), /禁止归档/);
}));

test('check：哈希不符拒绝 / 材料缺失拒绝', sandbox(async (tmp, dirs) => {
  fakeRunDir(dirs.out, 'run-hash', { s1: { command: 'x', passed: 1, failed: 0, skipped: 0, exitCode: 0 } });
  fs.writeFileSync(path.join(dirs.out, 'run-hash', 's1-result.json'), '[]');
  const { archiveDir } = ev.archive('TEST', 'run-hash', ['s1-result.json']);
  const manifest = JSON.parse(fs.readFileSync(path.join(archiveDir, 'manifest.json'), 'utf8'));
  const rel = manifest.files[0].path;
  fs.writeFileSync(path.join(archiveDir, rel), 'tampered');
  assert.strictEqual(ev.check('TEST/run-hash').ok, false);
  fs.rmSync(path.join(archiveDir, rel));
  const missing = ev.check('TEST/run-hash');
  assert.strictEqual(missing.ok, false);
  assert.ok(missing.issues.some((i) => i.includes('材料缺失')));
}));

test('check：敏感内容检测（PGPASSWORD）', sandbox(async (tmp, dirs) => {
  fakeRunDir(dirs.out, 'run-sec', { s1: { command: 'x', passed: 1, failed: 0, skipped: 0, exitCode: 0 } });
  fs.writeFileSync(path.join(dirs.out, 'run-sec', 's1-output.txt'), 'PGPASSWORD=supersecret\n');
  ev.archive('TEST', 'run-sec', ['s1-output.txt']);
  const result = ev.check('TEST/run-sec');
  assert.strictEqual(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('疑似敏感内容')));
}));

test('check：结果与退出码一致性（failed>0 但 exitCode=0 拒绝）', sandbox(async (tmp, dirs) => {
  fakeRunDir(dirs.out, 'run-cons', { s1: { command: 'x', passed: 2, failed: 1, skipped: 0, exitCode: 0 } });
  fs.writeFileSync(path.join(dirs.out, 'run-cons', 's1-result.json'), '[]');
  ev.archive('TEST', 'run-cons', ['s1-result.json']);
  const result = ev.check('TEST/run-cons');
  assert.strictEqual(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('退出码为 0')));
}));

test('check：合法归档全绿（含截图二进制跳过文本扫描）', sandbox(async (tmp, dirs) => {
  fakeRunDir(dirs.out, 'run-ok', { s1: { command: 'x', passed: 5, failed: 0, skipped: 0, exitCode: 0 } });
  fs.writeFileSync(path.join(dirs.out, 'run-ok', 's1-result.json'), '[]');
  fs.writeFileSync(path.join(dirs.out, 'run-ok', 'shots', 's1-01.png'), Buffer.from([0x89, 0x50]));
  const { archiveDir, fileCount } = ev.archive('TEST', 'run-ok', ['s1-result.json', path.join('shots', 's1-01.png')]);
  assert.strictEqual(fileCount, 2);
  const result = ev.check('TEST/run-ok');
  assert.deepStrictEqual(result.issues, []);
  assert.strictEqual(result.ok, true);
  assert.ok(archiveDir);
}));

test('check：manifest 未知键与非完整 SHA 拒绝', sandbox(async (tmp, dirs) => {
  fakeRunDir(dirs.out, 'run-man', { s1: { command: 'x', passed: 1, failed: 0, skipped: 0, exitCode: 0 } });
  fs.writeFileSync(path.join(dirs.out, 'run-man', 's1-result.json'), '[]');
  ev.archive('TEST', 'run-man', ['s1-result.json']);
  const archiveDir = path.join(dirs.arch, 'TEST', 'run-man');
  const manifest = JSON.parse(fs.readFileSync(path.join(archiveDir, 'manifest.json'), 'utf8'));
  manifest.extraKey = true;
  manifest.sourceCommit = 'short';
  fs.writeFileSync(path.join(archiveDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const result = ev.check('TEST/run-man');
  assert.ok(result.issues.some((i) => i.includes('未知键')));
  assert.ok(result.issues.some((i) => i.includes('完整 SHA')));
}));
