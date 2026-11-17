// M16 性能门禁分档复验：50/100/150 VU 各独立 3min 定档（精确分档 P95 + threshold 判定）
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:18083';
if (BASE_URL !== 'http://127.0.0.1:18083') throw new Error('Only isolated perf backend');
const PASSWORD = __ENV.PASSWORD || 'Accept!2026';
const MODEL_ID = __ENV.MODEL_ID || '1';
const LEVEL_VUS = parseInt(__ENV.LEVEL_VUS || '50');
const LEVEL_SECS = parseInt(__ENV.LEVEL_SECS || '180');

http.setResponseCallback(http.expectedStatuses(200, 201, 204, 304, 401));

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-vus',
      vus: LEVEL_VUS,
      duration: `${LEVEL_SECS}s`,
      gracefulStop: '15s',
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
    JSON.stringify({ username: 'accept_admin', password: PASSWORD }),
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
