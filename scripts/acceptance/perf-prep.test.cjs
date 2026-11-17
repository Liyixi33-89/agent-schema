const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const text = fs.readFileSync(path.join(__dirname, 'perf-prep.sh'), 'utf8');
const match = text.match(/<<'JSEOF'\r?\n([\s\S]*?)\r?\nJSEOF/);
assert.ok(match, 'generated k6 source must exist');
const source = match[1].replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
function initialize(env) {
  const context = vm.createContext({ __ENV: env, http: {}, check: () => true, sleep: () => {} });
  vm.runInContext(source + '\nthis.result = options;', context);
  return context.result;
}
const valid = { PASSWORD: 'synthetic-test-only', PERF_MODEL_ID: '1', PERF_APP_ID: '2', PERF_PAGE_ID: '3' };

test('all database commands remain on the isolated instance', () => {
  const commands = text.split(/\r?\n/).filter(line => /psql\s/.test(line));
  assert.ok(commands.length >= 4);
  for (const line of commands) assert.match(line, /psql -p 15433 -v ON_ERROR_STOP=1/);
});

test('generated source parses and exposes isolated workloads', () => {
  const options = initialize(valid);
  assert.equal(options.scenarios.reads.iterations, 1750);
  assert.equal(options.scenarios.writes.iterations, 500);
  assert.equal(options.scenarios.publishes.iterations, 250);
  assert.ok(options.thresholds['http_req_duration{type:publish}']);
  for (const kind of ['read', 'write', 'publish']) {
    assert.ok(options.thresholds[`http_req_failed{type:${kind}}`]);
  }
  assert.doesNotMatch(match[1], /gracefulRampDown|name: '(write|publish|schema_pull)'|accessToken/);
});
test('missing credentials or IDs fail before requests', () => {
  for (const key of Object.keys(valid)) {
    const env = { ...valid }; delete env[key];
    assert.throws(() => initialize(env));
  }
  assert.throws(() => initialize({ ...valid, PERF_MODEL_ID: '0' }));
});
test('workloads use Cookie/CSRF and real data/publish routes', () => {
  const requests = [];
  const cookies = { schema_at: [{ value: 'test-at' }], schema_rt: [{ value: 'test-rt' }],
    schema_csrf: [{ value: 'test-csrf' }] };
  const http = {
    get(url, params) {
      requests.push({ method: 'GET', url, params });
      return { status: 200, cookies };
    },
    post(url, body, params) {
      requests.push({ method: 'POST', url, body: JSON.parse(body), params });
      return { status: 200, cookies };
    },
  };
  const context = vm.createContext({ __ENV: valid, __VU: 1, __ITER: 2, http,
    check: (response, checks) => Object.values(checks).every(fn => fn(response)), sleep: () => {} });
  vm.runInContext(source + '\nreadWorkload(); writeWorkload(); publishWorkload();', context);
  const login = requests.find(r => r.url.endsWith('/api/auth/login'));
  assert.equal(login.body.username, 'perf_user');
  assert.equal(login.params.headers['X-CSRF-Token'], 'test-csrf');
  assert.ok(login.params.headers.Cookie.includes('schema_csrf='));
  const query = requests.find(r => r.url.endsWith('/api/data/1/query'));
  assert.equal(query.method, 'POST');
  assert.deepEqual(query.body, { page: 1, size: 20 });
  const write = requests.find(r => r.url.endsWith('/api/data/1'));
  assert.equal(write.body.title, 'perf_1_2');
  const publish = requests.find(r => r.url.endsWith('/api/apps/2/publish'));
  assert.equal(publish.params.tags.type, 'publish');
  for (const request of [query, write, publish]) {
    assert.ok(request.params.headers.Cookie.includes('schema_at=test-at'));
    assert.equal(request.params.headers['X-CSRF-Token'], 'test-csrf');
    assert.equal(request.params.headers.Authorization, undefined);
  }
});

test('online backend is rejected', () => {
  assert.throws(() => initialize({ ...valid, BASE_URL: 'http://127.0.0.1:18081' }));
});

test('baseline Python compiles and rejects missing model without database access', () => {
  const { spawnSync } = require('node:child_process');
  const baseline = text.match(/python3 - "\$STAGE_DIR" "\$PERF_DB" <<'PYEOF'\r?\n([\s\S]*?)\r?\nPYEOF/);
  assert.ok(baseline);
  const compiled = spawnSync('python', ['-c', 'import sys; compile(sys.stdin.read(), "baseline", "exec")'],
    { input: baseline[1], encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const env = { ...process.env, PERF_MODEL_ID: '', PERF_TENANT_ID: '999' };
  const result = spawnSync('python', ['-c', baseline[1], '.', 'schema_perf'], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PERF_MODEL_ID/);
});

test('baseline SQL is scoped to tenant and current schema version', () => {
  assert.match(text, /SELECT current_version FROM meta_model WHERE id=\{model_id\} AND tenant_id=\{tenant_id\}/);
  assert.match(text, /WHERE tenant_id=\{tenant_id\} AND schema_version=\{version\}/);
  assert.match(text, /if report\['status'\] != 'READY':\r?\n    raise SystemExit\(2\)/);
});

test('baseline execution distinguishes READY, NEED_SEED and query failure', () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const baseline = text.match(/python3 - "\$STAGE_DIR" "\$PERF_DB" <<'PYEOF'\r?\n([\s\S]*?)\r?\nPYEOF/)[1];
  const runner = `import sys, subprocess\nresponses = iter(sys.argv[2].split(','))\ndef fake_run(*args, **kwargs):\n    value = next(responses)\n    if value == 'ERROR': raise subprocess.CalledProcessError(1, args[0])\n    return subprocess.CompletedProcess(args[0], 0, stdout=value, stderr='')\nsubprocess.run = fake_run\nsys.argv = ['baseline', sys.argv[1], 'schema_perf']\nexec(compile(sys.stdin.read(), 'baseline', 'exec'))\n`;
  for (const scenario of [
    { values: '2,1,1000000', code: 0, status: 'READY' },
    { values: '2,1,999999', code: 2, status: 'NEED_SEED' },
    { values: 'ERROR', code: 1 },
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-baseline-test-'));
    try {
      const result = spawnSync('python', ['-c', runner, dir, scenario.values], {
        input: baseline, encoding: 'utf8',
        env: { ...process.env, PERF_MODEL_ID: '1', PERF_TENANT_ID: '999' },
      });
      assert.equal(result.status, scenario.code, result.stderr);
      const reportPath = path.join(dir, 'baseline-check.json');
      if (scenario.status) {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        assert.equal(report.status, scenario.status);
        assert.equal(report.schemaVersion, '2');
      } else {
        assert.equal(fs.existsSync(reportPath), false, 'query failure must not produce success report');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
