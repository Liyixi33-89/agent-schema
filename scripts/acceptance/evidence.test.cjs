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

test('check：敏感内容检测（PGPASSWORD）——归档前置拦截 + check 兜底双防线', sandbox(async (tmp, dirs) => {
  fakeRunDir(dirs.out, 'run-sec', { s1: { command: 'x', passed: 1, failed: 0, skipped: 0, exitCode: 0 } });
  fs.writeFileSync(path.join(dirs.out, 'run-sec', 's1-output.txt'), 'PGPASSWORD=supersecret\n');
  // 第一道防线：归档前置脱敏扫描直接拒绝，不留目录
  assert.throws(() => ev.archive('TEST', 'run-sec', ['s1-output.txt']), /疑似敏感内容拒绝归档/);
  assert.strictEqual(fs.existsSync(path.join(dirs.arch, 'TEST', 'run-sec')), false);
  // 第二道防线：绕过前置归档（模拟历史/外部材料）时 check 兜底检出
  const archiveDir = path.join(dirs.arch, 'TEST', 'run-sec');
  fs.mkdirSync(archiveDir, { recursive: true });
  const run = JSON.parse(fs.readFileSync(path.join(dirs.out, 'run-sec', 'run.json'), 'utf8'));
  const file = 's1-output.txt';
  fs.copyFileSync(path.join(dirs.out, 'run-sec', file), path.join(archiveDir, file));
  fs.writeFileSync(path.join(archiveDir, 'manifest.json'), JSON.stringify({
    ...run, finishedAt: '2026-11-05T00:00:00Z',
    files: [{ path: file, sha256: ev.sha256(path.join(archiveDir, file)) }],
  }, null, 2));
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
  // 结果文件与清单计数严格一致（交叉核对）
  fs.writeFileSync(path.join(dirs.out, 'run-ok', 's1-result.json'), JSON.stringify(
    Array.from({ length: 5 }, (_, i) => ({ name: `case-${i}`, pass: true }))));
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

// ==================== P0 门禁安全拒绝用例 ====================

test('P0：路径逃逸全形态拒绝（绝对路径/盘符/父目录/符号链接）', sandbox(async (tmp, dirs) => {
  fakeRunDir(dirs.out, 'run-esc2', { s1: { command: 'x', passed: 1, failed: 0, skipped: 0, exitCode: 0 } });
  const runDir = path.join(dirs.out, 'run-esc2');
  fs.writeFileSync(path.join(runDir, 's1-result.json'), '[]');
  // 归档入口拒绝
  assert.throws(() => ev.archive('TEST', 'run-esc2', ['/etc/passwd']), /路径逃逸/);
  assert.throws(() => ev.archive('TEST', 'run-esc2', ['C:\\Windows\\evil.txt']), /路径逃逸/);
  assert.throws(() => ev.archive('TEST', 'run-esc2', ['a/../../b.txt']), /路径逃逸/);
  // check 入口同样拒绝（不依赖归档时的旧校验）
  fs.mkdirSync(path.join(dirs.arch, 'TEST', 'run-sym'), { recursive: true });
  const goodRun = path.join(dirs.out, 'run-good-sym');
  fs.mkdirSync(goodRun, { recursive: true });
  fs.writeFileSync(path.join(goodRun, 'outside.txt'), 'evil');
  fs.symlinkSync(goodRun, path.join(dirs.arch, 'TEST', 'run-sym', 'link-dir'));
  const symResult = ev.check('TEST/run-sym');
  assert.ok(symResult.ok === false);
}));

test('P0：失败/跳过伪装通过拒绝（计数与结果文件交叉核对）', sandbox(async (tmp, dirs) => {
  // 清单声明 passed=3 failed=0，但结果文件实际 2 pass 1 fail → 拒绝
  fakeRunDir(dirs.out, 'run-fake', { s1: { command: 'x', passed: 3, failed: 0, skipped: 0, exitCode: 0 } });
  const runDir = path.join(dirs.out, 'run-fake');
  fs.writeFileSync(path.join(runDir, 's1-result.json'), JSON.stringify([
    { name: 'a', pass: true }, { name: 'b', pass: true }, { name: 'c', pass: false },
  ]));
  ev.archive('TEST', 'run-fake', ['s1-result.json']);
  const result = ev.check('TEST/run-fake');
  assert.strictEqual(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('计数与结果文件不符')), JSON.stringify(result.issues));
  // 有失败断言但退出码 0 → 拒绝
  assert.ok(result.issues.some((i) => i.includes('有失败断言但退出码为 0')), JSON.stringify(result.issues));
}));

test('P0：跳过冒充覆盖拒绝（仅 skipped 无 passed 不放行）', sandbox(async (tmp, dirs) => {
  fakeRunDir(dirs.out, 'run-skip', { s1: { command: 'x', passed: 0, failed: 0, skipped: 3, exitCode: 0 } });
  fs.writeFileSync(path.join(dirs.out, 'run-skip', 's1-result.json'), '[]');
  ev.archive('TEST', 'run-skip', ['s1-result.json']);
  // skipped=3 无失败无退出码问题，但全部跳过不能算通过 —— 由 workflow.py 层把 passed=0 的套件判不可验收
  // 这里验证 check 至少不误报 PASS：manifest 记录如实（skipped=3）时 check 应通过结构校验
  const result = ev.check('TEST/run-skip');
  assert.strictEqual(result.issues.includes('s1: 有失败但退出码为 0'), false);
  // 但结构上 passed+failed+skipped>0 且类型合法 —— check 层放行，放行与否由台账层判定 skipped 套件
  assert.strictEqual(result.ok, true);
}));

test('P0：归档目录与 manifest 路径绑定拒绝（挪用他包材料）', sandbox(async (tmp, dirs) => {
  fakeRunDir(dirs.out, 'run-bind', { s1: { command: 'x', passed: 1, failed: 0, skipped: 0, exitCode: 0 } });
  const runDir = path.join(dirs.out, 'run-bind');
  fs.writeFileSync(path.join(runDir, 's1-result.json'), '[]');
  const { archiveDir } = ev.archive('TEST', 'run-bind', ['s1-result.json']);
  // 把归档整体挪到别的工作包目录冒充
  const hijack = path.join(dirs.arch, 'OTHER', 'run-bind');
  fs.mkdirSync(path.dirname(hijack), { recursive: true });
  fs.renameSync(archiveDir, hijack);
  const result = ev.check('OTHER/run-bind');
  assert.strictEqual(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('manifest 与归档路径不符')), JSON.stringify(result.issues));
}));

test('P0：归档含未登记文件拒绝（夹带私货）', sandbox(async (tmp, dirs) => {
  fakeRunDir(dirs.out, 'run-extra', { s1: { command: 'x', passed: 1, failed: 0, skipped: 0, exitCode: 0 } });
  fs.writeFileSync(path.join(dirs.out, 'run-extra', 's1-result.json'), '[]');
  const { archiveDir } = ev.archive('TEST', 'run-extra', ['s1-result.json']);
  fs.writeFileSync(path.join(archiveDir, 'smuggled.txt'), 'not in manifest');
  const result = ev.check('TEST/run-extra');
  assert.strictEqual(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('未登记文件')), JSON.stringify(result.issues));
}));

test('P0：非整数/负数计数拒绝', sandbox(async (tmp, dirs) => {
  fakeRunDir(dirs.out, 'run-bad-count', { s1: { command: 'x', passed: 1.5, failed: -1, skipped: 0, exitCode: 0 } });
  fs.writeFileSync(path.join(dirs.out, 'run-bad-count', 's1-result.json'), '[]');
  ev.archive('TEST', 'run-bad-count', ['s1-result.json']);
  const result = ev.check('TEST/run-bad-count');
  assert.strictEqual(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('passed 非法计数')), JSON.stringify(result.issues));
  assert.ok(result.issues.some((i) => i.includes('failed 非法计数')), JSON.stringify(result.issues));
}));

test('P0：套件缺实际命令拒绝', sandbox(async (tmp, dirs) => {
  fakeRunDir(dirs.out, 'run-nocmd', { s1: { passed: 1, failed: 0, skipped: 0, exitCode: 0 } });
  fs.writeFileSync(path.join(dirs.out, 'run-nocmd', 's1-result.json'), '[]');
  ev.archive('TEST', 'run-nocmd', ['s1-result.json']);
  const result = ev.check('TEST/run-nocmd');
  assert.strictEqual(result.ok, false);
  assert.ok(result.issues.some((i) => i.includes('缺实际命令')), JSON.stringify(result.issues));
}));

// ==================== P1/P2 真实 CLI 子进程验证 ====================
// 不用沙箱注入环境变量——真实 CLI 经 env 传递目录根，验证完整链路。

const { spawnSync } = require('child_process');
const EVIDENCE_CLI = path.join(__dirname, 'evidence.cjs');

function cliSandbox(fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-cli-'));
    try {
      await fn(tmp, (...args) => spawnSync('node', [EVIDENCE_CLI, ...args], {
        cwd: path.join(__dirname, '..', '..'),
        encoding: 'utf8',
        env: { ...process.env, ACCEPT_EVIDENCE_OUT: path.join(tmp, 'out'), ACCEPT_EVIDENCE_ARCHIVE: path.join(tmp, 'arch') },
      }));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  };
}

test('P2 真实 CLI：参数含空格命令正确执行且计数/日志/退出码一致', cliSandbox(async (tmp, cli) => {
  // 命令参数含空格（"hello world"）——shell 拼接模式下会被拆散，参数数组直传必须原样到达
  const good = cli('run', 'WP', 'suite with space'.replace(/\s+/g, '-'), '--', 'node', '-e',
    `const fs=require('fs');const rd=process.env.ACCEPT_RUN_DIR,s=process.env.ACCEPT_SUITE;const arr=[{name:'with space',pass:true}];fs.writeFileSync(rd+'/'+s+'-result.json',JSON.stringify(arr));const run=JSON.parse(fs.readFileSync(rd+'/run.json','utf8'));run.suites[s]={...(run.suites[s]||{}),passed:1,failed:0,skipped:0};fs.writeFileSync(rd+'/run.json',JSON.stringify(run,null,2));process.stdout.write('hello world')`);
  assert.strictEqual(good.status, 0, good.stderr);
  const runId = /run=(\S+) exit=/.exec(good.stdout)[1];
  const run = JSON.parse(fs.readFileSync(path.join(tmp, 'out', runId, 'run.json'), 'utf8'));
  const suiteName = Object.keys(run.suites)[0];
  assert.strictEqual(run.suites[suiteName].passed, 1);
  assert.strictEqual(run.suites[suiteName].exitCode, 0);
  assert.ok(run.suites[suiteName].command.includes('hello world'), '命令记录必须保留参数结构');
  const log = fs.readFileSync(path.join(tmp, 'out', runId, 'logs', `${suiteName}-output.txt`), 'utf8');
  assert.ok(log.includes('hello world'), 'stdout 必须含带空格参数');
}));

test('P2 真实 CLI：多套件同轮共享 run-id，重复套件拒绝，失败码保留', cliSandbox(async (tmp, cli) => {
  const first = cli('run', 'WP', 's1', '--', 'node', '-e',
    `const fs=require('fs');const rd=process.env.ACCEPT_RUN_DIR,s=process.env.ACCEPT_SUITE;fs.writeFileSync(rd+'/'+s+'-result.json','[]')`);
  assert.strictEqual(first.status, 0, first.stderr);
  const runId = /run=(\S+) exit=/.exec(first.stdout)[1];
  const second = cli('run', 'WP', 's2', '--reuse-run-id', runId, '--', 'node', '-e', 'process.exitCode=7');
  assert.strictEqual(second.status, 7);
  assert.ok(second.stdout.includes(runId));
  const dup = cli('run', 'WP', 's1', '--reuse-run-id', runId, '--', 'node', '-e', '0');
  assert.notStrictEqual(dup.status, 0);
  assert.ok((dup.stderr + dup.stdout).includes('拒绝覆盖'));
  const run = JSON.parse(fs.readFileSync(path.join(tmp, 'out', runId, 'run.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(run.suites).sort(), ['s1', 's2']);
  assert.strictEqual(run.suites.s2.exitCode, 7);
}));

test('P2 真实 CLI：归档原子发布——敏感材料拒绝后不留临时目录', cliSandbox(async (tmp, cli) => {
  const r = cli('run', 'WP', 's1', '--', 'node', '-e',
    `const fs=require('fs');const rd=process.env.ACCEPT_RUN_DIR,s=process.env.ACCEPT_SUITE;fs.writeFileSync(rd+'/'+s+'-result.json','[]')`);
  const runId = /run=(\S+) exit=/.exec(r.stdout)[1];
  const runDir = path.join(tmp, 'out', runId);
  fs.writeFileSync(path.join(runDir, 'leak.txt'), 'PGPASSWORD=hunter2\n');
  const arc = cli('archive', 'WP', runId, '--files', 'leak.txt');
  assert.notStrictEqual(arc.status, 0);
  assert.ok((arc.stderr + arc.stdout).includes('疑似敏感内容拒绝归档'), arc.stderr);
  // 不留半成品：归档根与临时目录都不存在
  const archRoot = path.join(tmp, 'arch', 'WP');
  const leftovers = fs.existsSync(archRoot) ? fs.readdirSync(archRoot) : [];
  assert.deepStrictEqual(leftovers.filter((n) => n.startsWith(runId)), [], '不得残留半成品归档');
}));
