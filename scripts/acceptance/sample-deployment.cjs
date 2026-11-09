#!/usr/bin/env node
/**
 * M13 部署前后证据采样（自动探测版）：
 *  - before：部署面静态资源 HTTP 拉取算 SHA256 + 后端运行实例身份真实探测
 *  - 中间：跑验收动作（由调用方指定命令，或仅等待）
 *  - after：同方法再次独立探测
 *  - 输出 deployment.json：before/after 均为独立采样值，expected 只用于一致性判定，
 *    不参与生成——禁止手填。
 * 用法：node sample-deployment.cjs <runId> [--act "<命令>"]
 * 探测目标经隧道（本地 18081 → 服务器验收后端）+ 服务器 80 静态面。
 */
const { execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const runId = process.argv[2];
const actIdx = process.argv.indexOf('--act');
const actCmd = actIdx > -1 ? process.argv[actIdx + 1] : null;
if (!runId) { console.error('用法: node sample-deployment.cjs <runId> [--act "<命令>"]'); process.exit(2); }

const BACKEND = process.env.ACCEPT_BACKEND_ORIGIN || 'http://127.0.0.1:18081';
const STATIC = process.env.ACCEPT_STATIC_ORIGIN || 'http://111.231.57.177'; // 服务器部署面（80 端口 /accept/ 路径）
const PROBE_PATH = '/accept/designer/'; // 部署面入口（生产 80 alias；资源为构建指纹 index-*.js）

function httpGet(url, { auth = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout: ' + url)); });
    req.on('error', reject);
  });
}

async function sha256(buf) {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 后端运行实例身份：登录 → /api/system/build-identity（真实调用，不回退）。
 *  接口字段：sourceCommit（构建期注入的 git SHA）+ verifiable + instanceId（运行实例 UUID）。 */
async function probeBackendIdentity() {
  const { ApiClient } = require(path.join(ROOT, 'scripts/acceptance/accept-lib.cjs'));
  const c = new ApiClient('deploy-probe');
  const user = process.env.ACCEPT_USERNAME || 'accept_admin';
  const pass = process.env.ACCEPT_PASSWORD || 'Accept!2026';
  await c.login('部署探针', user, pass);
  const r = await c.call('GET', '/api/system/build-identity');
  if (r.status !== 200) throw new Error('build-identity 探测失败: HTTP ' + r.status + ' ' + r.raw.slice(0, 120));
  const j = r.json;
  if (j.verifiable !== true) throw new Error('build-identity 不可信（构建期未注入 commit）: ' + r.raw.slice(0, 120));
  return { commitId: j.sourceCommit, instanceId: j.instanceId, raw: JSON.stringify(j).slice(0, 200) };
}

async function sample() {
  // 1. 部署面静态资源（HTTP 响应体哈希）
  const st = await httpGet(STATIC + PROBE_PATH);
  if (st.status !== 200) throw new Error('静态面探测失败: HTTP ' + st.status);
  const staticSha = await sha256(st.body);
  // 2. 本地受控产物（对照值）
  const designerLocal = path.join(ROOT, 'schema-frontend/apps/designer/dist/index.html');
  const localSha = fs.existsSync(designerLocal) ? await sha256(fs.readFileSync(designerLocal)) : null;
  // 3. 后端实例身份
  const ident = await probeBackendIdentity();
  return { staticSha, localSha, ident };
}

(async () => {
  const sourceCommit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD']).toString().trim();
  console.log('sourceCommit:', sourceCommit);
  const before = await sample();
  console.log('before: static=' + before.staticSha.slice(0, 12) + ' ident=' + JSON.stringify(before.ident).slice(0, 120));

  if (actCmd) {
    console.log('act:', actCmd);
    const r = require('child_process').spawnSync(actCmd, { shell: true, cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) { console.error('验收动作退出码', r.status); process.exit(1); }
  }

  const after = await sample();
  console.log('after:  static=' + after.staticSha.slice(0, 12) + ' ident=' + JSON.stringify(after.ident).slice(0, 120));

  const dep = {
    sourceCommit,
    sampledAt: new Date().toISOString(),
    method: 'auto-probe',
    targets: [
      {
        name: 'designer-static',
        method: 'http-response-sha256',
        probeUrl: STATIC + PROBE_PATH,
        before: before.staticSha,
        after: after.staticSha,
        localDistSha256: after.localSha,
        consistent: before.staticSha === after.staticSha && (!after.localSha || after.localSha === before.staticSha),
      },
      {
        name: 'backend-identity',
        method: 'backend-build-identity',
        probeUrl: BACKEND + '/api/system/build-identity',
        before: { commitId: before.ident.commitId, instanceId: before.ident.instanceId },
        after: { commitId: after.ident.commitId, instanceId: after.ident.instanceId },
        consistent: before.ident.commitId === after.ident.commitId && before.ident.instanceId === after.ident.instanceId,
        commitMatchesSource: after.ident.commitId === sourceCommit,
      },
    ],
  };
  const failed = dep.targets.some((t) => t.consistent === false) || !dep.targets[1].commitMatchesSource;
  const out = path.join(ROOT, 'scripts/acceptance/out', runId, 'deployment.json');
  if (fs.existsSync(out)) { console.error('拒绝覆盖已存在 deployment.json:', out); process.exit(1); }
  fs.writeFileSync(out, JSON.stringify(dep, null, 2) + '\n');
  console.log(failed ? 'SAMPLE FAIL' : 'SAMPLE OK', '->', out);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('采样失败:', e.message); process.exit(1); });
