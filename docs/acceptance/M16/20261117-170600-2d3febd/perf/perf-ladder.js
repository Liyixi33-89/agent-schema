// M16 T3 PERF capacity ladder: find SLA-satisfying VU level on this 4C/3.6G single node
// stages: 50 VU -> 100 VU -> 150 VU, each 2min; read-heavy (70/20/10) per PERF-02
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:18083';
const PASSWORD = __ENV.PASSWORD || 'Accept!2026';
const ADMIN = 'accept_admin';
const MODEL_ID = __ENV.MODEL_ID || '1';

export const options = {
  scenarios: {
    mixed: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },   // warmup + 50VU level
        { duration: '90s', target: 50 },
        { duration: '30s', target: 100 },  // 100VU level
        { duration: '90s', target: 100 },
        { duration: '30s', target: 150 },  // 150VU level
        { duration: '90s', target: 150 },
        { duration: '20s', target: 0 },
      ],
      gracefulStop: '30s',
    },
  },
  thresholds: {
    // SLA: p95 < 1.5s for reads/writes (PRD11 capacity baseline)
    'http_req_duration{type:query}': ['p(95)<1500'],
    'http_req_duration{type:write}': ['p(95)<1500'],
    'http_req_duration{type:publish}': ['p(95)<1500'],
  },
};

const SESSION_TTL_MS = 25 * 60 * 1000;
let session = null;
function login() {
  if (session && Date.now() - session.at < SESSION_TTL_MS) return session;
  const pre = http.get(`${BASE_URL}/api/auth/csrf`);
  let csrfCookie = '';
  (pre.cookies['schema_csrf'] || []).forEach((c) => { csrfCookie = c.value; });
  const headers = { 'Content-Type': 'application/json', 'Origin': BASE_URL };
  if (csrfCookie) {
    headers['Cookie'] = `schema_csrf=${csrfCookie}`;
    headers['X-CSRF-Token'] = csrfCookie;
  }
  const res = http.post(`${BASE_URL}/api/auth/login`,
    JSON.stringify({ username: ADMIN, password: PASSWORD }), { headers });
  check(res, { 'login ok': (r) => r.status === 200 || r.status === 400 });
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
    // read
    const q = http.post(`${BASE_URL}/api/data/${MODEL_ID}/query`,
      JSON.stringify({ page: (1 + __ITER % 50), size: 20 }),
      { headers: auth(), tags: { type: 'query' } });
    check(q, { 'query ok': (r2) => r2.status === 200 });
  } else if (r < 90) {
    // write
    const res = http.post(`${BASE_URL}/api/data/${MODEL_ID}`,
      JSON.stringify({ title: `perf_${__VU}_${__ITER}`, amount: __ITER % 1000 }),
      { headers: auth(), tags: { type: 'write' } });
    check(res, { 'write ok': (r2) => r2.status === 200 || r2.status === 201 });
  } else {
    // publish
    const res = http.post(`${BASE_URL}/api/apps/1/publish`,
      JSON.stringify({ changelog: `perf ${__VU}_${__ITER}` }),
      { headers: auth(), tags: { type: 'publish' } });
    check(res, { 'publish ok': (r2) => r2.status === 200 });
  }
  sleep(1);
}
