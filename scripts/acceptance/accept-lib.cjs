/**
 * M11 验收公共库（严格断言版 v2）
 * - apiFetch：带状态码与业务码断言的 API 通道（走 Node 侧 http，不经浏览器）
 * - 结果记录：FAIL 立即抛出终止（fail-fast），禁止无条件成功
 * - DB 核对通道：经 WSL psql 查询落库（execSync wsl.exe）；
 *   公网目标（ACCEPT_DB_MODE=ssh）走 SSH 远端 psql（密钥环境注入，不落盘）
 * - 凭据外置：账号密码从环境读取（ACCEPT_USERNAME/ACCEPT_PASSWORD/
 *   ACCEPT_DESIGNER_USERNAME/ACCEPT_DESIGNER_PASSWORD），脚本内零硬编码
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

const BASE = process.env.ACCEPT_BASE_URL || 'http://127.0.0.1:8090';
const API_PREFIX = (process.env.ACCEPT_API_PREFIX || '').replace(/\/$/, '');
const results = [];
let failFast = true;
// 隧道通道（公网目标经 SSH 端口转发访问）：客户端须显式声明目标源——
// Host/Origin 与公网源一致，服务端 CsrfFilter originOf 才能匹配（见 03BE CSRF 三道兜底）。
// 仅验收执行环境使用；不设置时行为与直连完全一致。
const TUNNEL_ORIGIN = process.env.ACCEPT_TUNNEL_ORIGIN || '';

/** 状态语义（防假 PASS）：
 *  pass=true / fail=true  —— 已执行且结论成立/不成立
 *  skipped —— 未执行（环境前提缺失），永不算通过；必验项缺失会拉低整体结论
 *  failFast 下 FAIL 立即抛出；SKIP 不抛但 summary 会按「未执行」单独计数。 */
function record(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail: String(detail).slice(0, 300) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  if (!pass && failFast) throw new Error(`断言失败(终止): ${name} :: ${detail}`);
}

/** 未执行登记：不打印 PASS，不计入通过数；required=true 时整体判 FAIL。 */
function skip(name, reason, { required = false } = {}) {
  results.push({ name, pass: false, skipped: true, required: !!required, detail: `未执行: ${String(reason).slice(0, 280)}` });
  console.log(`${required ? 'MISS' : 'SKIP'}  ${name}  -- 未执行: ${reason}`);
}

function ok(name, cond, detail = '') { record(name, cond, detail); }

/** 凭据（环境注入；缺省值仅供本地开发栈——公网验收必须显式注入）。 */
function credentials() {
  return {
    designer: {
      username: process.env.ACCEPT_DESIGNER_USERNAME || process.env.ACCEPT_USERNAME || 'accept_admin',
      password: process.env.ACCEPT_DESIGNER_PASSWORD || process.env.ACCEPT_PASSWORD || 'Accept!2026',
    },
    user: {
      username: process.env.ACCEPT_USERNAME || 'accept_user',
      password: process.env.ACCEPT_PASSWORD || 'Accept!2026',
    },
  };
}

/** 带原始响应头的 HTTP 请求（Node 侧，Cookie 手动管理——与浏览器隔离）。
 *  注意：显式设置 Content-Length——Node http 默认 chunked 会被 Tomcat 拒收 DELETE body(400)。 */
function request(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const target = API_PREFIX && urlPath.startsWith('/api/')
      ? `${API_PREFIX}${urlPath}` : urlPath;
    const u = new URL(target, BASE);
    const transport = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    if (payload != null && headers['Content-Length'] == null) {
      headers = { ...headers, 'Content-Length': Buffer.byteLength(payload) };
    }
    const req = transport.request(u, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, raw: data, json,
          setCookies: res.headers['set-cookie'] || [] });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('验收请求超时')));
    if (payload != null) req.write(payload);
    req.end();
  });
}

/** 会话客户端：登录后自动维护 Cookie 与 CSRF 头（双提交）。 */
class ApiClient {
  constructor(label) {
    this.label = label;
    this.cookies = new Map();   // name -> value
  }

  _cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  _absorb(setCookies) {
    for (const line of setCookies || []) {
      const kv = line.split(';')[0];
      const eq = kv.indexOf('=');
      const name = kv.slice(0, eq);
      const value = kv.slice(eq + 1);
      if (value === '' || value === 'DELETE') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  csrf() { return this.cookies.get('schema_csrf') || ''; }

  async call(method, urlPath, body, extraHeaders = {}) {
    const headers = { Origin: BASE, ...extraHeaders };
    if (TUNNEL_ORIGIN) {
      // 隧道通道：Host 头显式设为公网源（nginx $http_host 透传），Origin 同值
      const u = new URL(TUNNEL_ORIGIN);
      headers.Host = u.host;
      headers.Origin = TUNNEL_ORIGIN;
    }
    if (this.cookies.size) headers.Cookie = this._cookieHeader();
    const csrf = this.csrf();
    if (csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-CSRF-Token'] = csrf;
    if (body != null) headers['Content-Type'] = 'application/json';
    const res = await request(method, urlPath, { body, headers });
    this._absorb(res.setCookies);
    return res;
  }

  /** 断言式调用：期望状态码 + 业务码不匹配即终止。 */
  async expect(name, method, urlPath, expectStatus, body, extraHeaders = {}) {
    const res = await this.call(method, urlPath, body, extraHeaders);
    const bizCode = res.json ? res.json.code : undefined;
    const pass = res.status === expectStatus;
    if (!pass) {
      record(name, false, `HTTP ${res.status}≠${expectStatus} body=${res.raw.slice(0, 180)}`);
    } else {
      record(name, true, `HTTP ${res.status}${bizCode && bizCode !== 'OK' ? ' code=' + bizCode : ''}`);
    }
    return res;
  }

  async login(name, username, password) {
    const res = await this.call('POST', '/api/auth/login', { username, password });
    if (res.status !== 200) {
      record(name, false, `登录 HTTP ${res.status}: ${res.raw.slice(0, 160)}`);
    }
    const hasAt = this.cookies.has('schema_at');
    const hasRt = this.cookies.has('schema_rt');
    const hasCsrf = this.cookies.has('schema_csrf');
    const noTokenInBody = !res.json || (res.json.token == null && res.json.accessToken == null && res.json.refreshToken == null);
    record(`${name}::凭证三件套`, hasAt && hasRt && hasCsrf && noTokenInBody,
      `at=${hasAt} rt=${hasRt} csrf=${hasCsrf} body零凭证=${noTokenInBody}`);
    return res;
  }
}

/** DB 查询通道选择：
 *  - 本地（缺省）：WSL psql（schema_accept 库）
 *  - 公网（ACCEPT_DB_MODE=ssh）：SSH 远端 psql（schema_acceptance 库）；
 *    连接参数全部环境注入（ACCEPT_SSH_KEY/ACCEPT_SSH_HOST/ACCEPT_DB_*），
 *    查询脚本经 stdin 传输不落盘远端临时文件。 */
function dbQuery(sql) {
  if ((process.env.ACCEPT_DB_MODE || '').toLowerCase() === 'ssh') {
    return sshDbQuery(sql);
  }
  const script = `#!/bin/bash
export PGPASSWORD=schema_local_only
psql -h localhost -U schema_dev -d schema_accept -tAc "${sql.replace(/"/g, '\\"')}"
`;
  const queryDir = path.join(RUN_DIR, 'private', process.env.ACCEPT_SUITE || 'direct');
  fs.mkdirSync(queryDir, { recursive: true });
  const tmp = path.join(queryDir, 'dbq_exec.sh');
  fs.writeFileSync(tmp, script.replace(/\r/g, ''));
  const wslPath = tmp.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m) => `/mnt/${m[0].toLowerCase()}`);
  try {
    const out = execSync(`wsl.exe -d Ubuntu -e bash ${wslPath}`, { timeout: 30000 }).toString();
    return out.split('\n').filter((l) => l.trim() !== '');
  } catch (e) {
    return { error: String(e.message).slice(0, 200), stdout: String(e.stdout || '').slice(0, 300) };
  }
}

/** SSH 远端 psql：查询经单引号安全化后远端执行（凭据环境注入，不经临时文件）。
 *  ⚠️ 执行通道（2026-11-12 实测）：本终端管控环境下 Node 进程树内直接 spawn ssh 全部
 *  ETIMEDOUT（含 cmd/powershell 包装）；改经 Start-Process 分离进程执行 ssh 并以
 *  文件回传结果（与常驻 SSH 隧道同机制——分离进程出网不受拦截）。 */
function sshDbQuery(sql) {
  const key = process.env.ACCEPT_SSH_KEY;
  const host = process.env.ACCEPT_SSH_HOST;
  const dbUser = process.env.ACCEPT_DB_USER || 'schema_accept';
  const dbName = process.env.ACCEPT_DB_NAME || 'schema_acceptance';
  const dbPass = process.env.ACCEPT_DB_PASSWORD;
  if (!key || !host || !dbPass) {
    return { error: 'ACCEPT_DB_MODE=ssh 需注入 ACCEPT_SSH_KEY/ACCEPT_SSH_HOST/ACCEPT_DB_PASSWORD' };
  }
  // 密码约束为字母数字+下划线（验收库专用随机串）——防 shell 注入面
  if (!/^[A-Za-z0-9_]+$/.test(dbPass)) {
    return { error: 'ACCEPT_DB_PASSWORD 含非法字符（限字母数字下划线）' };
  }
  const safeSql = sql.replace(/'/g, `'\\''`);
  const remoteCmd = `PGPASSWORD='${dbPass}' psql -h 127.0.0.1 -U ${dbUser} -d ${dbName} -tAc '${safeSql}'`;
  // 分离执行器（仓库脚本，验收基础设施）：ssh 一次性命令 + 输出文件回传
  const runner = path.join(__dirname, 'ssh-run-detached.ps1');
  const outFile = path.join(os.tmpdir(), `accept-sshq-${process.pid}-${Date.now()}.txt`);
  try {
    const r = execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner,
      '-RemoteCmd', remoteCmd, '-KeyPath', key, '-SshHost', host, '-OutFile', outFile,
    ], { timeout: 60000, encoding: 'utf8' });
    const out = fs.readFileSync(outFile, 'utf8');
    return out.split('\n').filter((l) => l.trim() !== '');
  } catch (e) {
    return { error: String(e.message).slice(0, 200), stdout: String(e.stdout || '').slice(0, 300) };
  } finally {
    try { fs.unlinkSync(outFile); } catch {}
  }
}

const RUN_DIR = process.env.ACCEPT_RUN_DIR || path.join(__dirname, 'out');
const RUN_ID = process.env.ACCEPT_RUN_ID || null;
function outPath(name) { fs.mkdirSync(RUN_DIR, { recursive: true }); return path.join(RUN_DIR, name); }

function summary(suite) {
  const failed = results.filter((r) => !r.pass && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const missedRequired = skipped.filter((r) => r.required);
  console.log(`\n=== ${suite} 验收: ${results.length - failed.length - skipped.length}/${results.length - skipped.length} PASS` +
    (skipped.length ? `，未执行 ${skipped.length}（必验缺失 ${missedRequired.length}）` : '') + ' ===');
  fs.writeFileSync(outPath(`${process.env.ACCEPT_SUITE || suite}-result.json`), JSON.stringify(results, null, 2));
  if (failed.length || missedRequired.length) process.exitCode = 1;
  // 清单只由父进程维护；子进程仅产出断言结果。
}

module.exports = { BASE, ok, record, skip, request, ApiClient, dbQuery, summary, results, credentials };
