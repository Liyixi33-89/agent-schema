/**
 * M11/M12 验收静态代理（8090）：单根合并三 dist + /api 反代 18080。
 * - /designer/*  → schema-frontend/apps/designer/dist
 * - /runtime/*   → schema-frontend/apps/runtime/dist
 * - /admin/*     → schema-frontend/apps/admin-console/dist
 * - /api/*       → http://127.0.0.1:18080（含 Cookie 透传）
 * 零依赖（node 原生 http），验收专用不入产品链路。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST_ROOT = path.resolve(__dirname, '../../schema-frontend/apps');
const APPS = { designer: 'designer', runtime: 'runtime', admin: 'admin-console' };
const BACKEND = { host: '127.0.0.1', port: 18080 };
const PORT = 8090;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.map': 'application/json', '.ico': 'image/x-icon',
};

function proxy(req, res) {
  // 透传原始 Host 头——后端 CsrfFilter.originOf 按 Host 头计算 target Origin，
  // 改写 Host 会导致 Origin 精确匹配失效（8090 → 18080 不匹配 → CSRF_ORIGIN_REJECTED）
  const up = http.request({ host: BACKEND.host, port: BACKEND.port, path: req.url, method: req.method, headers: req.headers },
    (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
  up.on('error', () => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'BAD_GATEWAY' })); });
  req.pipe(up);
}

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    res.end(buf);
  });
}

http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  // 根路径服务 runtime（M11 验收约定：/#/app/1 hash 路由挂根——302 到 designer 会劫持断言）
  if (u.pathname === '/' || u.pathname.startsWith('/assets/')) {
    const rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    const file = path.join(DIST_ROOT, 'runtime', 'dist', rel);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) { sendFile(res, file); return; }
  }
  if (u.pathname.startsWith('/api/')) { proxy(req, res); return; }
  const seg = u.pathname.split('/')[1];
  const appDir = APPS[seg];
  if (!appDir) { res.writeHead(404); res.end('unknown app'); return; }
  const rel = u.pathname.slice(`/${seg}/`.length) || 'index.html';
  const file = path.join(DIST_ROOT, appDir, 'dist', rel);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) { sendFile(res, file); return; }
  // SPA fallback
  const index = path.join(DIST_ROOT, appDir, 'dist', 'index.html');
  if (fs.existsSync(index)) { sendFile(res, index); return; }
  res.writeHead(404); res.end(`dist missing for ${seg} — run pnpm build`);
}).listen(PORT, '127.0.0.1', () => console.log(`acceptance proxy on :${PORT} → backend :${BACKEND.port}`));
