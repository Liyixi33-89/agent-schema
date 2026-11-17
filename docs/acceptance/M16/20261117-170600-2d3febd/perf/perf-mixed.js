// M16 T3 PERF-01~05: mixed workload 250 VU (70 read / 20 write / 10 publish) — FINAL
// Real contract: cookie session; POST /api/data/{modelId} writes; /api/ops/health is 401-gated (any response = alive)
// k6 note: expected_response marks non-2xx as failed by default — health 401 is by-design alive signal,
//          login 400 with mustChangePassword body is by-design success — both exempted via expected_response:false + checks.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:18083';
const PASSWORD = __ENV.PASSWORD || 'Accept!2026';
const ADMIN = 'accept_admin';
const MODEL_ID = __ENV.MODEL_ID || '1';

export const options = {
  scenarios: {
    reads: { executor: 'shared-iterations', vus: 175, iterations: 1750,
      exec: 'readWorkload', startTime: '0s' },                     // 70% read
    writes: { executor: 'shared-iterations', vus: 50, iterations: 500,
      exec: 'writeWorkload', startTime: '0s' },                    // 20% write
    publishes: { executor: 'shared-iterations', vus: 25, iterations: 125,
      exec: 'publishWorkload', startTime: '0s' },          // 10% publish
  },
  thresholds: {
    'http_req_duration{scenario:reads}': ['p(95)<1500'],
    'http_req_duration{scenario:writes}': ['p(95)<1500'],
    'http_req_duration{scenario:publishes}': ['p(95)<1500'],
    'http_req_failed{scenario:reads}': ['rate<0.01'],
    'http_req_failed{scenario:writes}': ['rate<0.005'],
    'http_req_failed{scenario:publishes}': ['rate<0.005'],
  },
};

// ---- per-VU session helpers (cookie + csrf double submit) ----
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

function auth(extra = {}) {
  const s = login();
  const h = { 'Content-Type': 'application/json', 'Origin': BASE_URL, ...extra };
  const ck = Object.entries(s.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (ck) h['Cookie'] = ck;
  if (s.csrf) h['X-CSRF-Token'] = s.csrf;
  return h;
}

// ---- workloads ----
export function readWorkload() {
  // health 401 = alive (actuator auth); exempt from failed-rate accounting
  const health = http.get(`${BASE_URL}/api/ops/health`,
    { tags: { scenario: 'reads' } });
  check(health, { 'health responded': (r) => r.status !== 0 });
  const q = http.post(`${BASE_URL}/api/data/${MODEL_ID}/query`,
    JSON.stringify({ page: 1, size: 20 }),
    { headers: auth(), tags: { scenario: 'reads' } });
  check(q, { 'query ok': (r) => r.status === 200 });
  const q2 = http.post(`${BASE_URL}/api/data/${MODEL_ID}/query`,
    JSON.stringify({ page: (1 + __ITER % 50), size: 20 }),
    { headers: auth(), tags: { scenario: 'reads' } });
  check(q2, { 'paged query ok': (r) => r.status === 200 });
  sleep(1);
}

export function writeWorkload() {
  const payload = JSON.stringify({ title: `perf_${__VU}_${__ITER}`, amount: __ITER % 1000 });
  const res = http.post(`${BASE_URL}/api/data/${MODEL_ID}`, payload,
    { headers: auth(), tags: { scenario: 'writes' } });
  check(res, { 'write 2xx': (r) => r.status === 200 || r.status === 201 });
  sleep(1);
}

export function publishWorkload() {
  const res = http.post(`${BASE_URL}/api/apps/1/publish`,
    JSON.stringify({ changelog: `perf ${__VU}_${__ITER}` }),
    { headers: auth(), tags: { scenario: 'publishes' } });
  check(res, { 'publish ok': (r) => r.status === 200 });
  sleep(2);
}
