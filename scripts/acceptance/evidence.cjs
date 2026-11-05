/**
 * 验收证据工具（零依赖）：运行隔离 / 归档 / 校验 —— 规范真源见 docs/acceptance/README.md
 *
 * 运行隔离：
 *   const { suite } = require('./evidence.cjs').run('M13', ['designer']);
 *   - 首次调用生成 run-id（UTC+8：YYYYMMDD-HHmmss-<shortsha>），写入 out/<run-id>/run.json
 *   - 同进程同轮共享；套件产物写 out/<run-id>/<suite>-result.json、shots/<suite>/
 *   - 并发/重复 run-id 目录已存在时自动加序号后缀，禁止覆盖
 *
 * 归档：node scripts/acceptance/evidence.cjs archive <workPackage> <runId> --files ...
 *   - 目标 docs/acceptance/<workPackage>/<run-id>/，拒绝覆盖已有归档
 *   - 自动生成 manifest.json + files.json（SHA256 清单），不写评审结论
 *
 * 校验：node scripts/acceptance/evidence.cjs check <archiveDir>
 *   - 结构/哈希/路径逃逸/禁入类型/敏感模式/结果与退出码一致
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
/** 目录根惰性解析：测试/CI 可用 ACCEPT_EVIDENCE_OUT / ACCEPT_EVIDENCE_ARCHIVE 覆盖。 */
function outRoot() { return process.env.ACCEPT_EVIDENCE_OUT || path.join(__dirname, 'out'); }
function archiveRoot() { return process.env.ACCEPT_EVIDENCE_ARCHIVE || path.join(ROOT, 'docs', 'acceptance'); }
const FORBIDDEN_NAMES = [/^chrome-profile-/i, /^dbq_exec\.sh$/i, /\.cookie$/i, /\.env$/i, /^\.profile/i];
const FORBIDDEN_CONTENT = [
  /PGPASSWORD=[^\s]+/i,
  /DB_PASSWORD=[^\s\\n]+/i,
  /(bearer|authorization)\s*[:=]\s*[\w\-._~+/]+=*/i,
  /(jwt|secret|api[_-]?key)\s*[:=]\s*['"]?[\w\-]{16,}/i,
];
const ALLOWED_MANIFEST_KEYS = new Set(['formatVersion', 'workPackage', 'runId', 'startedAt', 'finishedAt', 'sourceCommit',
  'workingTreeClean', 'environment', 'suites', 'supersedes', 'files']);

function gitHead() {
  try { return execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); }
  catch { return null; }
}

function workingTreeClean() {
  try {
    const out = execSync('git status --porcelain -- schema-frontend schema-platform scripts contract sql', { cwd: ROOT, encoding: 'utf8' });
    return out.trim() === '';
  } catch { return false; }
}

/** 防路径逃逸：解析后必须落在基准目录内。 */
function safeJoin(base, rel) {
  const resolved = path.resolve(base, rel);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error(`路径逃逸拒绝: ${rel}`);
  return resolved;
}

function sha256(file) {
  const { createHash } = require('crypto');
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** UTC+8 本地时间戳；run-id 全程字符串，禁止把 Date 直接写进 JSON。 */
function timestamp(date = new Date()) {
  const t = new Date(date.getTime() + 8 * 3600 * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}-${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`;
}

function isoNow() { return new Date().toISOString(); }

function loadOrCreateRun(workPackage) {
  const head = gitHead();
  if (!head) throw new Error('不在 git 仓库内，无法生成 run-id');
  let base = `${timestamp()}-${head.slice(0, 7)}`;
  let runId = base;
  for (let i = 2; fs.existsSync(path.join(outRoot(), runId)); i++) runId = `${base}-${i}`; // 并发防覆盖
  const runDir = path.join(outRoot(), runId);
  fs.mkdirSync(path.join(runDir, 'shots'), { recursive: true });
  const run = {
    formatVersion: 1,
    workPackage,
    runId,
    startedAt: isoNow(),
    sourceCommit: head,
    workingTreeClean: workingTreeClean(),
    environment: { os: process.platform, node: process.version },
    suites: {},
  };
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(run, null, 2));
  return { run, runDir };
}

/** 套件上下文：同轮所有套件共享 run.json 与 runDir；每个套件记录命令、退出码、计数。 */
function suite(runDir, suiteName, command) {
  const runFile = path.join(runDir, 'run.json');
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  run.suites[suiteName] = { command, startedAt: isoNow(), passed: 0, failed: 0, skipped: 0 };
  const persist = () => fs.writeFileSync(runFile, JSON.stringify(run, null, 2));
  persist();
  return {
    runId: run.runId,
    runDir,
    /** 结果 JSON 与截图都按套件隔离命名。 */
    resultFile: path.join(runDir, `${suiteName}-result.json`),
    shotDir: path.join(runDir, 'shots', suiteName),
    count(passed, failed, skipped) {
      run.suites[suiteName].passed = passed; run.suites[suiteName].failed = failed; run.suites[suiteName].skipped = skipped;
      persist();
    },
    exit(code) {
      run.suites[suiteName].exitCode = code === undefined ? (process.exitCode || 0) : code;
      run.suites[suiteName].finishedAt = isoNow();
      persist();
    },
  };
}

module.exports.RUN_HELP = `node scripts/acceptance/evidence.cjs run <workPackage> <suite> -- node scripts/acceptance/accept-xxx.cjs`;

/** 统一运行入口：生成/复用 run-id，执行命令并如实记录退出码（不吞、不改写）。 */
function runCommand(workPackage, suiteName, cmd) {
  const { run, runDir } = loadOrCreateRun(workPackage);
  const ctx = suite(runDir, suiteName, cmd.join(' '));
  fs.mkdirSync(ctx.shotDir, { recursive: true });
  let exitCode = 0;
  try {
    execSync(cmd.join(' '), { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ACCEPT_RUN_DIR: ctx.runDir, ACCEPT_RUN_ID: ctx.runId } });
  } catch (e) {
    exitCode = typeof e.status === 'number' ? e.status : 1; // 失败退出码必须保留
  }
  ctx.exit(exitCode);
  return { runId: ctx.runId, runDir, exitCode };
}

/** 归档：run.json → manifest.json；复制指定材料；生成 SHA256 清单；拒绝覆盖与禁入文件。 */
function archive(workPackage, runId, files) {
  const runDir = path.join(outRoot(), runId);
  const runFile = path.join(runDir, 'run.json');
  if (!fs.existsSync(runFile)) throw new Error(`运行目录不存在: ${runId}`);
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const dstRoot = safeJoin(archiveRoot(), path.join(workPackage, runId));
  if (fs.existsSync(dstRoot)) throw new Error(`归档已存在，拒绝覆盖: ${workPackage}/${runId}`);
  // 先完成全部校验，再写盘——任何拒绝都不留半成品目录
  const planned = [];
  for (const rel of files) {
    const src = safeJoin(runDir, rel);
    const name = path.basename(rel);
    if (FORBIDDEN_NAMES.some((re) => re.test(name))) throw new Error(`禁止归档文件类型: ${rel}`);
    if (!fs.existsSync(src)) throw new Error(`材料缺失: ${rel}`);
    planned.push({ rel, src });
  }
  fs.mkdirSync(dstRoot, { recursive: true });
  const copied = [];
  for (const { rel, src } of planned) {
    const dst = safeJoin(dstRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied.push({ path: rel, sha256: sha256(dst) });
  }
  const manifest = {
    formatVersion: 1,
    workPackage,
    runId,
    startedAt: run.startedAt,
    finishedAt: isoNow(),
    sourceCommit: run.sourceCommit,
    workingTreeClean: run.workingTreeClean,
    environment: run.environment,
    suites: run.suites,
  };
  manifest.files = copied;
  fs.writeFileSync(path.join(dstRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { archiveDir: dstRoot, fileCount: copied.length };
}

/** 校验归档：结构/哈希/路径/禁入/敏感内容/结果与退出码一致。FAIL 以非零退出，绝不静默。 */
function check(archiveRel) {
  const issues = [];
  const dir = safeJoin(archiveRoot(), archiveRel);
  const manifestFile = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) return { ok: false, issues: ['manifest.json 缺失'] };
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  for (const key of Object.keys(m)) {
    if (!ALLOWED_MANIFEST_KEYS.has(key)) issues.push(`manifest 未知键: ${key}`);
  }
  for (const key of ['formatVersion', 'workPackage', 'runId', 'startedAt', 'finishedAt', 'sourceCommit', 'suites']) {
    if (m[key] === undefined) issues.push(`manifest 缺字段: ${key}`);
  }
  if (m.sourceCommit && !/^[0-9a-f]{40}$/.test(m.sourceCommit)) issues.push('sourceCommit 非完整 SHA');
  const suiteNames = Object.keys(m.suites || {});
  if (!suiteNames.length) issues.push('manifest 无套件记录');
  for (const rel of (m.files || [])) {
    const f = path.join(dir, rel.path);
    if (!fs.existsSync(f)) { issues.push(`材料缺失: ${rel.path}`); continue; }
    if (sha256(f) !== rel.sha256) issues.push(`哈希不符: ${rel.path}`);
    if (FORBIDDEN_NAMES.some((re) => re.test(path.basename(rel.path)))) issues.push(`禁入类型: ${rel.path}`);
    if (/\.(png|jpg|jpeg)$/i.test(rel.path)) continue; // 二进制不做文本扫描
    const text = fs.readFileSync(f, 'utf8');
    for (const re of FORBIDDEN_CONTENT) if (re.test(text)) { issues.push(`疑似敏感内容: ${rel.path}`); break; }
  }
  for (const [name, s] of Object.entries(m.suites || {})) {
    if (s.failed > 0 && s.exitCode === 0) issues.push(`${name}: 有失败但退出码为 0`);
    if (s.passed + s.failed + s.skipped === 0) issues.push(`${name}: 无断言记录`);
    if (s.exitCode !== 0 && s.exitCode !== undefined && s.failed === 0 && !s.skipped) issues.push(`${name}: 非零退出但无失败记录`);
  }
  return { ok: issues.length === 0, issues };
}

/** CLI 统一入口：run / archive / check。 */
function main() {
  const [action, ...rest] = process.argv.slice(2);
  if (action === 'run') {
    const [workPackage, suiteName, , ...cmd] = rest; // 第 3 位是 "--"
    if (!workPackage || !suiteName || !cmd.length) { console.error(module.exports.RUN_HELP); process.exit(2); }
    const { runId, exitCode } = runCommand(workPackage, suiteName, cmd);
    console.log(`\n[evidence] run=${runId} exit=${exitCode}`);
    process.exitCode = exitCode;
    return;
  }
  if (action === 'archive') {
    const [workPackage, runId] = rest;
    const files = rest.slice(2).filter((x) => x !== '--');
    if (!workPackage || !runId || !files.length) { console.error('usage: evidence.cjs archive <workPackage> <runId> --files <rel...>'); process.exit(2); }
    const result = archive(workPackage, runId, files);
    console.log(`[evidence] archived ${result.fileCount} files -> ${path.relative(ROOT, result.archiveDir)}`);
    return;
  }
  if (action === 'check') {
    const [archiveRel] = rest;
    if (!archiveRel) { console.error('usage: evidence.cjs check <archiveDir>'); process.exit(2); }
    const result = check(archiveRel);
    if (result.issues.length) console.error(result.issues.join('\n'));
    console.log(`[evidence] check ${result.ok ? 'PASS' : 'FAIL'} (${archiveRel})`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  console.error('usage: evidence.cjs <run|archive|check> ...');
  process.exit(2);
}

if (require.main === module) main();

module.exports = { ROOT, outRoot, archiveRoot, run: loadOrCreateRun, suite, runCommand, archive, check, sha256, safeJoin, timestamp };

