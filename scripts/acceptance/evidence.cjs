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

/** 仓库根：默认本仓库；测试可用 SCHEMA_EVIDENCE_ROOT 指向临时 Git 仓库。 */
const ROOT = process.env.SCHEMA_EVIDENCE_ROOT ? path.resolve(process.env.SCHEMA_EVIDENCE_ROOT)
  : path.resolve(__dirname, '..', '..');
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
  base = path.resolve(base);
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)
      || rel.split(/[\\/]/).includes('..')) throw new Error(`路径逃逸拒绝: ${rel}`);
  const resolved = path.resolve(base, rel);
  if (resolved === base || !resolved.startsWith(base + path.sep)) throw new Error(`路径逃逸拒绝: ${rel}`);
  let current = resolved;
  while (current !== base) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`符号链接拒绝: ${rel}`);
    current = path.dirname(current);
  }
  return resolved;
}

function sha256(file) {
  const { createHash } = require('crypto');
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 递归列出归档内全部文件（相对路径），用于检查未登记材料。 */
function walk(dir, prefix = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...walk(path.join(dir, ent.name), rel));
    else out.push(rel);
  }
  return out;
}

/** UTC+8 本地时间戳；run-id 全程字符串，禁止把 Date 直接写进 JSON。 */
function timestamp(date = new Date()) {
  const t = new Date(date.getTime() + 8 * 3600 * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}-${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`;
}

function isoNow() { return new Date().toISOString(); }

function loadOrCreateRun(workPackage, reuseRunId) {
  const head = gitHead();
  if (!head) throw new Error('不在 git 仓库内，无法生成 run-id');
  if (reuseRunId) {
    // 显式复用：同轮多套件共享 run-id；套件冲突由 suite() 拒绝，不覆盖
    const runDir = safeJoin(outRoot(), reuseRunId);
    const runFile = path.join(runDir, 'run.json');
    if (!fs.existsSync(runFile)) throw new Error('复用运行不存在，必须先创建运行');
    const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    if (run.workPackage !== workPackage || run.sourceCommit !== head || run.runId !== reuseRunId) {
      throw new Error('复用运行工作包、源码提交或标识不一致');
    }
    return { run, runDir, reused: true };
  }
  let base = `${timestamp()}-${head.slice(0, 7)}`;
  let runId = base;
  // 原子创建：mkdir 成功即占用；并发同秒自然滑到下一个序号，不存在检查-创建竞态
  for (let i = 2; !tryMkdirUnique(path.join(outRoot(), runId)); i++) runId = `${base}-${i}`;
  const runDir = path.join(outRoot(), runId);
  fs.mkdirSync(path.join(runDir, 'shots'), { recursive: true });
  const run = freshRun(workPackage, head, runId);
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(run, null, 2));
  return { run, runDir, reused: false };
}

function freshRun(workPackage, head, runId) {
  return {
    formatVersion: 1,
    workPackage,
    runId,
    startedAt: isoNow(),
    sourceCommit: head,
    workingTreeClean: workingTreeClean(),
    environment: { os: process.platform, node: process.version },
    suites: {},
  };
}

/** 原子占用：父目录先就位，末级目录 mkdir 成功即独占；已存在/并发冲突返回 false。 */
function tryMkdirUnique(dir) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try { fs.mkdirSync(dir, { recursive: false }); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
}

/** 套件上下文：同轮所有套件共享 run.json 与 runDir；重复套件名拒绝覆盖。 */
function suite(runDir, suiteName, command) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(suiteName)) throw new Error(`套件名非法: ${suiteName}`);
  const runFile = path.join(runDir, 'run.json');
  // 每次读盘最新状态再合并——子进程可能已写入计数，禁止用旧内存对象覆盖
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  if (run.suites[suiteName] && run.suites[suiteName].exitCode !== undefined) {
    throw new Error(`套件已执行过，拒绝覆盖: ${suiteName}`);
  }
  const persist = (patch) => {
    const latest = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    if (latest.suites[suiteName] && latest.suites[suiteName].exitCode !== undefined && patch && patch.exitCode === undefined) {
      throw new Error(`套件已结束，拒绝回写: ${suiteName}`);
    }
    latest.suites[suiteName] = { ...(latest.suites[suiteName] || {}), ...patch };
    fs.writeFileSync(runFile, JSON.stringify(latest, null, 2));
  };
  persist({ command, startedAt: isoNow(), passed: 0, failed: 0, skipped: 0 });
  return {
    runId: run.runId,
    runDir,
    /** 结果 JSON 与截图都按套件隔离命名。 */
    resultFile: path.join(runDir, `${suiteName}-result.json`),
    shotDir: path.join(runDir, 'shots', suiteName),
    count(passed, failed, skipped) { persist({ passed, failed, skipped }); },
    exit(code) {
      persist({ exitCode: code === undefined ? (process.exitCode || 0) : code, finishedAt: isoNow() });
    },
  };
}

module.exports.RUN_HELP = `node scripts/acceptance/evidence.cjs run <workPackage> <suite> [--reuse-run-id <runId>] -- <命令...>\n多套件同轮：首次 run 生成 run-id，后续套件 --reuse-run-id <runId> 追加；重复套件名拒绝。`;

/** 统一运行入口：生成/复用 run-id，参数数组执行子进程；父进程只记录退出码，计数由子进程写入。 */
function runCommand(workPackage, suiteName, cmd, { reuseRunId } = {}) {
  if (!cmd.length) throw new Error('命令为空');
  const { run, runDir } = loadOrCreateRun(workPackage, reuseRunId);
  const ctx = suite(runDir, suiteName, cmd.join(' '));
  fs.mkdirSync(ctx.shotDir, { recursive: true });
  const { spawnSync } = require('child_process');
  const logFile = path.join(runDir, 'logs', `${suiteName}-output.txt`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  // 参数数组直传（不经 shell 拼接——引号注入与 DEP0190 风险）；可执行文件解析失败才回退 shell
  let result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: ROOT, shell: false,
    env: { ...process.env, ACCEPT_RUN_DIR: ctx.runDir, ACCEPT_RUN_ID: ctx.runId, ACCEPT_SUITE: suiteName },
  });
  // 不回退 shell：可执行文件不存在时如实失败，避免参数被重新解释。

  fs.writeFileSync(logFile, Buffer.concat([result.stdout || Buffer.alloc(0), result.stderr || Buffer.alloc(0)]));
  let exitCode = typeof result.status === 'number' ? result.status : 1;
  if (result.error && exitCode === 1) {
    fs.appendFileSync(logFile, `\n[evidence] 启动失败: ${result.error.message}\n`);
  }
  if (fs.existsSync(ctx.resultFile)) {
    const rows = JSON.parse(fs.readFileSync(ctx.resultFile, 'utf8'));
    if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.pass !== 'boolean')) {
      throw new Error('套件结果必须为含布尔 pass 的断言数组');
    }
    const skipped = rows.filter((r) => r.skipped === true).length;
    const failed = rows.filter((r) => r.skipped !== true && r.pass === false).length;
    ctx.count(rows.length - failed - skipped, failed, skipped);
    if (failed && exitCode === 0) exitCode = 1;
  }
  ctx.exit(exitCode);
  return { runId: ctx.runId, runDir, exitCode };
}

/** 归档：run.json → manifest.json；复制指定材料；生成 SHA256 清单；拒绝覆盖与禁入文件；原子发布。 */
function archive(workPackage, runId, files) {
  const runDir = safeJoin(outRoot(), runId);
  const runFile = path.join(runDir, 'run.json');
  if (!fs.existsSync(runFile)) throw new Error(`运行目录不存在: ${runId}`);
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  if (run.workPackage !== workPackage) throw new Error(`工作包不符: run=${run.workPackage} ≠ ${workPackage}`);
  const dstRoot = safeJoin(archiveRoot(), path.join(workPackage, runId));
  if (fs.existsSync(dstRoot)) throw new Error(`归档已存在，拒绝覆盖: ${workPackage}/${runId}`);
  // 先完成全部校验（存在性、禁入、敏感内容），再写盘——任何拒绝都不留半成品目录
  const planned = [];
  for (const rel of files) {
    const src = safeJoin(runDir, rel);
    const name = path.basename(rel);
    if (FORBIDDEN_NAMES.some((re) => re.test(name))) throw new Error(`禁止归档文件类型: ${rel}`);
    if (!fs.existsSync(src)) throw new Error(`材料缺失: ${rel}`);
    if (fs.statSync(src).isDirectory()) throw new Error(`材料是目录而非文件: ${rel}`);
    if (!/\.(png|jpg|jpeg)$/i.test(rel)) {
      const text = fs.readFileSync(src, 'utf8');
      for (const re of FORBIDDEN_CONTENT) if (re.test(text)) throw new Error(`疑似敏感内容拒绝归档: ${rel}`);
    }
    planned.push({ rel, src });
  }
  // 原子发布：临时目录写完整体改名；失败清理临时目录
  const tmpRoot = `${dstRoot}.tmp-${process.pid}-${Date.now() % 100000}`;
  fs.mkdirSync(tmpRoot, { recursive: true });
  const copied = [];
  try {
    for (const { rel, src } of planned) {
      const dst = safeJoin(tmpRoot, rel);
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
    fs.writeFileSync(path.join(tmpRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.renameSync(tmpRoot, dstRoot);
  } catch (e) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    throw e;
  }
  return { archiveDir: dstRoot, fileCount: copied.length };
}

/** 校验归档：结构/哈希/路径/禁入/敏感内容/结果与退出码一致。FAIL 以非零退出，绝不静默。 */
function check(archiveRel) {
  const issues = [];
  const dir = safeJoin(archiveRoot(), archiveRel);
  const manifestFile = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) return { ok: false, issues: ['manifest.json 缺失'] };
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const [wpSeg, runSeg] = archiveRel.split(/[\\/]/).filter(Boolean);
  if (m.workPackage !== wpSeg || m.runId !== runSeg) issues.push('manifest 与归档路径不符（工作包或 run-id）');
  for (const key of Object.keys(m)) {
    if (!ALLOWED_MANIFEST_KEYS.has(key)) issues.push(`manifest 未知键: ${key}`);
  }
  for (const key of ['formatVersion', 'workPackage', 'runId', 'startedAt', 'finishedAt', 'sourceCommit', 'suites']) {
    if (m[key] === undefined) issues.push(`manifest 缺字段: ${key}`);
  }
  if (m.workPackage !== undefined && (!m.workPackage || /[\\/]/.test(m.workPackage))) issues.push('workPackage 非法');
  if (m.runId !== undefined && (!m.runId || /[\\/]/.test(m.runId))) issues.push('runId 非法');
  if (m.sourceCommit && !/^[0-9a-f]{40}$/.test(m.sourceCommit)) issues.push('sourceCommit 非完整 SHA');
  const suiteNames = Object.keys(m.suites || {});
  if (!suiteNames.length) issues.push('manifest 无套件记录');
  for (const name of suiteNames) {
    const s = m.suites[name];
    if (typeof s.command !== 'string' || !s.command.trim()) issues.push(`${name}: 缺实际命令`);
    for (const k of ['passed', 'failed', 'skipped']) {
      if (!Number.isInteger(s[k]) || s[k] < 0) issues.push(`${name}: ${k} 非法计数`);
    }
    if (!Number.isInteger(s.exitCode) || s.exitCode < 0) issues.push(`${name}: exitCode 非法`);
    if ((s.passed || 0) + (s.failed || 0) + (s.skipped || 0) === 0) issues.push(`${name}: 无断言记录`);
  }
  for (const rel of (m.files || [])) {
    let f;
    try { f = safeJoin(dir, rel.path); }
    catch (e) { issues.push(e.message); continue; }
    if (!fs.existsSync(f)) { issues.push(`材料缺失: ${rel.path}`); continue; }
    if (sha256(f) !== rel.sha256) issues.push(`哈希不符: ${rel.path}`);
    if (FORBIDDEN_NAMES.some((re) => re.test(path.basename(rel.path)))) issues.push(`禁入类型: ${rel.path}`);
    if (/\.(png|jpg|jpeg)$/i.test(rel.path)) continue; // 二进制不做文本扫描
    const text = fs.readFileSync(f, 'utf8');
    for (const re of FORBIDDEN_CONTENT) if (re.test(text)) { issues.push(`疑似敏感内容: ${rel.path}`); break; }
    // 结果 JSON 交叉核对：清单计数必须与材料内断言一致，防手改 manifest 冒充通过
    if (/^[^\\/]+-result\.json$/.test(path.basename(rel.path))) {
      const name = path.basename(rel.path, '.json').replace(/-result$/, '');
      const s = (m.suites || {})[name];
      let arr = null;
      try { const parsed = JSON.parse(text); arr = Array.isArray(parsed) ? parsed : null; } catch { arr = null; }
      if (s && arr) {
        const passed = arr.filter((r) => r && r.pass === true).length;
        const failed = arr.length - passed;
        if (s.passed !== passed || s.failed !== failed) issues.push(`${rel.path}: 计数与结果文件不符`);
        if (failed > 0 && s.exitCode === 0) issues.push(`${rel.path}: 有失败断言但退出码为 0`);
      }
    }
  }
  const archived = new Set((m.files || []).map((f) => f.path.replace(/\\/g, '/')));
  const allowedExtra = new Set(['manifest.json']);
  for (const entry of walk(dir)) {
    const rel = entry.replace(/\\/g, '/');
    if (!archived.has(rel) && !allowedExtra.has(rel)) issues.push(`归档含未登记文件: ${rel}`);
  }
  for (const [name, s] of Object.entries(m.suites || {})) {
    if (s.failed > 0 && s.exitCode === 0) issues.push(`${name}: 有失败但退出码为 0`);
    if (s.passed + s.failed + s.skipped === 0) issues.push(`${name}: 无断言记录`);
    if (s.exitCode !== 0 && s.exitCode !== undefined && s.failed === 0 && !s.skipped) issues.push(`${name}: 非零退出但无失败记录`);
  }
  return { ok: issues.length === 0, issues };
}

/** CLI run 参数解析：--reuse-run-id 显式复用；"--" 后为命令参数数组；未知参数拒绝。 */
function parseRunArgs(rest) {
  const cmdStart = rest.indexOf('--');
  const opts = { reuseRunId: null, cmd: cmdStart === -1 ? [] : rest.slice(cmdStart + 1) };
  const headArgs = cmdStart === -1 ? rest : rest.slice(0, cmdStart);
  for (let i = 0; i < headArgs.length; i++) {
    if (headArgs[i] === '--reuse-run-id') {
      if (i + 1 >= headArgs.length) throw new Error('--reuse-run-id 缺值');
      opts.reuseRunId = headArgs[i + 1];
      i++;
    } else {
      throw new Error(`未知参数拒绝: ${headArgs[i]}`);
    }
  }
  return opts;
}

/** CLI 统一入口：run / archive / check。 */
function main() {
  const [action, ...rest] = process.argv.slice(2);
  if (action === 'run') {
    const [workPackage, suiteName] = rest;
    let opts;
    try { opts = parseRunArgs(rest.slice(2)); }
    catch (e) { console.error(e.message); console.error(module.exports.RUN_HELP); process.exit(2); }
    if (!workPackage || !suiteName || !opts.cmd.length) { console.error(module.exports.RUN_HELP); process.exit(2); }
    const { runId, exitCode } = runCommand(workPackage, suiteName, opts.cmd, { reuseRunId: opts.reuseRunId });
    console.log(`\n[evidence] run=${runId} exit=${exitCode}`);
    process.exitCode = exitCode;
    return;
  }
  if (action === 'archive') {
    const [workPackage, runId] = rest;
    const tail = rest.slice(2);
    const idx = tail.indexOf('--files');
    if (idx === -1 || !workPackage || !runId) { console.error('usage: evidence.cjs archive <workPackage> <runId> --files <rel...>'); process.exit(2); }
    const unknown = tail.slice(0, idx).filter((x) => x !== '--');
    if (unknown.length) { console.error('未知参数拒绝: ' + unknown.join(' ')); process.exit(2); }
    const files = tail.slice(idx + 1);
    if (!files.length) { console.error('usage: evidence.cjs archive <workPackage> <runId> --files <rel...>'); process.exit(2); }
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

module.exports = { ROOT, outRoot, archiveRoot, run: loadOrCreateRun, suite, runCommand, archive, check, sha256, safeJoin, timestamp, walk, parseRunArgs };

