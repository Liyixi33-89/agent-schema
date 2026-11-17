// M16 性能门禁复验：70/20/10 混合负载（修正 failed 口径——expected_response 显式声明）
// 与 perf-mixed.js 区别：
//   1. csrf 预热/health 探针/304 响应不再污染 http_req_failed（setResponseCallback 按业务语义判定期望）
//   2. 业务错误判定以 check 为准（query ok / write 2xx / publish ok）
//   3. 发布负载单独打点（type tag）供独立 P95 导出
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:18083';
if (BASE_URL !== 'http://127.0.0.1:18083') throw new Error('Only isolated perf backend');
const PASSWORD = __ENV.PASSWORD || 'Accept!2026';
const ADMIN = 'accept_admin';
const MODEL_ID = __ENV.MODEL_ID || '1';

// 业务期望响应：2xx 全算成功；304（schema 缓存）也算成功；401 只在 health 探针合法
http.setResponseCallback(http.expectedStatuses(200, 201, 204, 304, 401));

export const options = {
  scenarios: {
    mixed: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '90s', target: 50 },
        { duration: '30s', target: 100 },
        { duration: '90s', target: 100 },
        { duration: '30s', target: 150 },
        { duration: '90s', target: 150 },
        { duration: '20s', target: 0 },
      ],
      gracefulStop: '30s',
    },
  },
  thresholds: {
    'http_req_duration{type:query}': ['p(95)<1500'],
    'http_req_duration{type:write}': ['p(95)<1500'],
    'http_req_duration{type:publish}': ['p(95)<1500'],
    'checks': ['rate==1'],
  },
};

const SESSION_TTL_MS = 25 * 60 * 1000;
let session = null;
function login() {
  if (session && Date.now() - session.at < SESSION_TTL_MS) return session;
  const pre = http.get(`${BASE_URL}/api/auth/csrf`, { tags: { type: 'csrf' } });
  let csrfCookie = '';
  (pre.cookies['schema_csrf'] || []).forEach((c) => { csrfCookie = c.value; });
  const headers = { 'Content-Type': 'application/json', 'Origin': BASE_URL };
  if (csrfCookie) {
    headers['Cookie'] = `schema_csrf=${csrfCookie}`;
    headers['X-CSRF-Token'] = csrfCookie;
  }
  const res = http.post(`${BASE_URL}/api/auth/login`,
    JSON.stringify({ username: ADMIN, password: PASSWORD }),
    { headers, tags: { type: 'login' } });
  const jar = {};
  ['schema_at', 'schema_rt', 'schema_csrf'].forEach((k) => {
    (res.cookies[k] || []).forEach((c) => { jar[k] = c.value; });
  });
  session = { cookies: jar, csrf: jar['schema_csrf'] || csrfCookie, at: Date.now() };
  return session;
}
function auth() {
  const s = login();
  const h = { 'Content-Type': 'application/json', 'Origin': BASE_URL };
  const ck = Object.entries(s.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (ck) h['Cookie'] = ck;
  if (s.csrf) h['X-CSRF-Token'] = s.csrf;
  return h;
}

export default function () {
  const r = Math.random() * 100;
  if (r < 70) {
    const q = http.post(`${BASE_URL}/api/data/${MODEL_ID}/query`,
      JSON.stringify({ page: (1 + __ITER % 50), size: 20 }),
      { headers: auth(), tags: { type: 'query' } });
    check(q, { 'query ok': (r2) => r2.status === 200 });
  } else if (r < 90) {
    const res = http.post(`${BASE_URL}/api/data/${MODEL_ID}`,
      JSON.stringify({ title: `perf_${__VU}_${__ITER}`, amount: __ITER % 1000 }),
      { headers: auth(), tags: { type: 'write' } });
    check(res, { 'write 2xx': (r2) => r2.status === 200 || r2.status === 201 });
  } else {
    const res = http.post(`${BASE_URL}/api/apps/1/publish`,
      JSON.stringify({ changelog: `perf ${__VU}_${__ITER}` }),
      { headers: auth(), tags: { type: 'publish' } });
    check(res, { 'publish ok': (r2) => r2.status === 200 });
  }
  sleep(1);
}
