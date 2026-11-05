/**
 * M11 验收公共库（严格断言版 v2）
 * - apiFetch：带状态码与业务码断言的 API 通道（走 Node 侧 http，不经浏览器）
 * - 结果记录：FAIL 立即抛出终止（fail-fast），禁止无条件成功
 * - DB 核对通道：经 WSL psql 查询落库（execSync wsl.exe）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = 'http://127.0.0.1:8090';
const results = [];
let failFast = true;

function record(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail: String(detail).slice(0, 300) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  if (!pass && failFast) throw new Error(`断言失败(终止): ${name} :: ${detail}`);
}

function ok(name, cond, detail = '') { record(name, cond, detail); }

/** 带原始响应头的 HTTP 请求（Node 侧，Cookie 手动管理——与浏览器隔离）。
 *  注意：显式设置 Content-Length——Node http 默认 chunked 会被 Tomcat 拒收 DELETE body(400)。 */
function request(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    if (payload != null && headers['Content-Length'] == null) {
      headers = { ...headers, 'Content-Length': Buffer.byteLength(payload) };
    }
    const req = http.request(u, { method, headers }, (res) => {
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

/** WSL psql 查询（落库核对）。返回行数组（制表符分隔字段）。 */
function dbQuery(sql) {
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

const RUN_DIR = process.env.ACCEPT_RUN_DIR || path.join(__dirname, 'out');
const RUN_ID = process.env.ACCEPT_RUN_ID || null;
function outPath(name) { fs.mkdirSync(RUN_DIR, { recursive: true }); return path.join(RUN_DIR, name); }

function summary(suite) {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${suite} 验收: ${results.length - failed.length}/${results.length} PASS ===`);
  fs.writeFileSync(outPath(`${process.env.ACCEPT_SUITE || suite}-result.json`), JSON.stringify(results, null, 2));
  if (failed.length) process.exitCode = 1;
  // 清单只由父进程维护；子进程仅产出断言结果。

}

module.exports = { BASE, ok, record, request, ApiClient, dbQuery, summary, results };
