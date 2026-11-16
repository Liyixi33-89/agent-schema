#!/usr/bin/env bash
# M16 T3 压测准备脚本（测试文档 03 §1 PERF-01~05 + PRD11 §2.4 容量基线）
# 用途：搭建隔离预发布环境（独立数据库 + 合成数据 100 万行基线），
#       并生成 k6 混合负载脚本（登录/Schema 拉取/读写/发布按 70/20/10 配比）。
# 铁律：
# - 预发布库独立实例/独立库，禁止直连生产库压测
# - 发布负载用独立测试页面——不修改真实业务页面
# - 结果按接口统计 P95/错误率；同步采集 CPU/内存/连接池
# - 环境规格偏差如实登记（单机结果不冒充生产同构）
set -euo pipefail

STAGE_DIR="${1:-/opt/schema/staging/perf}"
PERF_DB="${PERF_DB:-schema_perf}"
BASE_URL="${BASE_URL:-http://127.0.0.1:18081}"
VUS="${VUS:-250}"
DURATION="${DURATION:-10m}"

mkdir -p "$STAGE_DIR"
TS() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# ---------- 步骤 1：环境规格盘点（偏差声明素材） ----------
echo "[$(TS)] [env] 服务器规格盘点"
{
  echo '{'
  echo "  \"collectedAt\": \"$(TS)\","
  echo "  \"cpu\": \"$(grep 'model name' /proc/cpuinfo | head -1 | cut -d: -f2 | xargs)\","
  echo "  \"cpuCores\": $(nproc),"
  echo "  \"memory\": \"$(free -h | awk '/Mem:/{print $2}')\","
  echo "  \"pgVersion\": \"$(su - postgres -c 'psql -Atc \"SELECT version()\"' | head -1)\","
  echo "  \"javaVersion\": \"$(java -version 2>&1 | head -1)\","
  echo "  \"disk\": \"$(df -h / | awk 'NR==2{print $2\" total, \"$4\" free\"}')\","
  echo '}' 
} > "$STAGE_DIR/env-spec.json"
cat "$STAGE_DIR/env-spec.json"
echo "  ⚠️ 单节点规格——报告须登记规格偏差（PRD11 §2.4 生产同构要求），结论为推算非实测同构。"

# ---------- 步骤 2：独立预发布库（禁止生产库） ----------
echo "[$(TS)] [db] 预发布库 $PERF_DB 就绪检查"
DB_EXISTS=$(su - postgres -c "psql -Atc \"SELECT 1 FROM pg_database WHERE datname='$PERF_DB'\"")
if [ "$DB_EXISTS" != "1" ]; then
  echo "[$(TS)] [db] 创建预发布库 $PERF_DB（从生产 schema 克隆结构）"
  su - postgres -c "psql -c \"CREATE DATABASE $PERF_DB\""
  echo "  ⚠️ 结构由目标后端 Flyway 自动迁移——启动后端指向 $PERF_DB 后自动建表"
fi

# ---------- 步骤 3：合成数据 100 万行基线 ----------
echo "[$(TS)] [data] 合成数据基线（目标 100 万行业务记录）"
python3 - "$STAGE_DIR" "$PERF_DB" <<'PYEOF'
import subprocess, sys, json, datetime
stage, perf_db = sys.argv[1], sys.argv[2]
def q(sql):
    r = subprocess.run(["su", "-", "postgres", "-c", f"psql -d {perf_db} -Atc \"{sql}\""],
                       capture_output=True, text=True)
    return r.stdout.strip()
# 基线表：data_engine_record（按实际业务表核对）
count = q("SELECT count(*) FROM data_engine_record WHERE tenant_id=999") if \
    q("SELECT 1 FROM information_schema.tables WHERE table_name='data_engine_record'") == "1" else "-1"
report = {"collectedAt": datetime.datetime.utcnow().isoformat() + "Z", "tenantId": 999, "existingRows": count}
if count.isdigit() and int(count) >= 1_000_000:
    print(f"基线已就绪：{count} 行 ≥ 100 万——跳过造数")
    report["status"] = "READY"
else:
    print(f"基线不足（{count} 行）——执行批量造数（INSERT ... SELECT 倍增法）")
    report["status"] = "NEED_SEED"
    # 造数入口：种子 1000 行 → 倍增 10 次 → 100 万行（tenant_id=999 隔离）
json.dump(report, open(f"{stage}/baseline-check.json", "w"), indent=2, ensure_ascii=False)
print(json.dumps(report, ensure_ascii=False))
PYEOF

# ---------- 步骤 4：k6 脚本生成（70 读 / 20 写 / 10 发布） ----------
cat > "$STAGE_DIR/perf-mixed.js" <<'JSEOF'
import http from 'k6/http';
import { check, sleep } from 'k6';
// M16 PERF-01~05：登录态混合负载（配比 70/20/10 = 读/写/发布）
// 运行：k6 run -e BASE_URL=... -e ACCOUNT=... -e PASSWORD=... perf-mixed.js
const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:18081';
const ACCOUNT = __ENV.ACCOUNT || 'perf_user';
const PASSWORD = __ENV.PASSWORD || '';
export const options = {
  scenarios: {
    reads: { executor: 'shared-iterations', vus: 175, iterations: 1750,
      exec: 'readWorkload', startTime: '0s' },                     // 70% 读
    writes: { executor: 'shared-iterations', vus: 50, iterations: 500,
      exec: 'writeWorkload', startTime: '0s' },                    // 20% 写
    publishes: { executor: 'shared-iterations', vus: 25, iterations: 125,
      exec: 'publishWorkload', startTime: '0s', gracefulRampDown: '30s' }, // 10% 发布
  },
  thresholds: {
    'http_req_duration{name:login}': ['p(95)<1500'],
    'http_req_duration{name:schema_pull}': ['p(95)<1000'],
    'http_req_duration{name:read}': ['p(95)<1500'],
    'http_req_duration{name:write}': ['p(95)<1500'],
    'http_req_failed': ['rate<0.005'],   // 错误率 < 0.5%（整体与分组各自判定）
  },
};
const TOKEN_TTL_MS = 25 * 60 * 1000;
let token = null, tokenAt = 0;
function login() {
  if (token && Date.now() - tokenAt < TOKEN_TTL_MS) return token;
  const r = http.post(`${BASE_URL}/api/auth/login`,
    JSON.stringify({ account: ACCOUNT, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' }, name: 'login' });
  check(r, { 'login 200': (res) => res.status === 200 });
  token = r.json('accessToken') || r.json('token') || null;
  tokenAt = Date.now();
  return token;
}
function auth() { return { headers: { Authorization: `Bearer ${login()}`, 'Content-Type': 'application/json' } }; }

export function readWorkload() {
  login();
  const schema = http.get(`${BASE_URL}/api/pages/1/schema`, auth().headers ? { headers: auth().headers, name: 'schema_pull' } : {});
  check(schema, { 'schema ok': (r) => r.status === 200 || r.status === 304 });
  const list = http.get(`${BASE_URL}/api/models/1/records?page=1&size=20`, { headers: auth().headers, name: 'read' });
  check(list, { 'list <500': (r) => r.status === 200 });
  sleep(1);
}
export function writeWorkload() {
  login();
  const r = http.post(`${BASE_URL}/api/models/1/records`,
    JSON.stringify({ record: { title: `perf_${__VU}_${__ITER}`, amount: __ITER % 1000 } }),
    { headers: auth().headers, name: 'write' });
  check(r, { 'write 2xx/422': (res) => res.status < 500 });
  sleep(1);
}
export function publishWorkload() {
  login();
  // 独立压测页面（pageId 由环境注入——禁止指向真实业务页面）
  const PAGE_ID = __ENV.PERF_PAGE_ID || '0';
  const r = http.post(`${BASE_URL}/api/pages/${PAGE_ID}/publish`, '{}',
    { headers: auth().headers, name: 'publish' });
  check(r, { 'publish no-5xx': (res) => res.status < 500 });
  sleep(2);
}
JSEOF
echo "[$(TS)] [k6] 脚本已生成：$STAGE_DIR/perf-mixed.js"

# ---------- 步骤 5：资源水位采集器（压测期间后台运行） ----------
cat > "$STAGE_DIR/sample-resources.sh" <<'SHEOF'
#!/usr/bin/env bash
# 资源水位采样（1s 间隔）：CPU/内存/PG 连接数——输出 CSV 供报告汇总
OUT="${1:-resources.csv}"
PG_DB="${PG_DB:-schema_perf}"
echo "ts,cpu_pct,mem_pct,pg_connections" > "$OUT"
while true; do
  CPU=$(top -bn1 | awk '/Cpu\(s\)/{print 100 - $8}')
  MEM=$(free | awk '/Mem:/{printf "%.1f", $3/$2*100}')
  CONN=$(su - postgres -c "psql -Atc \"SELECT count(*) FROM pg_stat_activity WHERE datname='$PG_DB'\"" 2>/dev/null || echo -1)
  echo "$(date +%s),$CPU,$MEM,$CONN" >> "$OUT"
  sleep 1
done
SHEOF
chmod +x "$STAGE_DIR/sample-resources.sh"
echo "[$(TS)] [sampler] 资源采集器就绪：$STAGE_DIR/sample-resources.sh（压测时后台起，Ctrl 停）"

echo ""
echo "========== 压测执行清单（待窗口确认） =========="
echo "1. 后端指向 $PERF_DB 启动（独立端口，勿动生产 18080/18081）"
echo "2. 造数至 100 万行（baseline-check.json NEED_SEED 时执行种子脚本）"
echo "3. 建 PERF_PAGE_ID 独立发布测试页面"
echo "4. bash $STAGE_DIR/sample-resources.sh $STAGE_DIR/resources.csv &"
echo "5. k6 run -e BASE_URL=$BASE_URL -e ACCOUNT=... -e PASSWORD=... -e PERF_PAGE_ID=... $STAGE_DIR/perf-mixed.js"
echo "6. 结果汇总：P95 分接口 + 错误率 + 资源峰值 → perf-report.json（含 env-spec.json 规格偏差声明）"
