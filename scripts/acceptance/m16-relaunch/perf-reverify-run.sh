#!/usr/bin/env bash
# M16 性能门禁复验执行器（perf-reverify.js + 资源采样 + 结果汇总）
# 修正项（本轮差距清单）：
#   [1] expected_response 口径修正——csrf/health/304 不再污染错误率
#   [2] 分接口独立 P95（query/write/publish 各自导出）
#   [3] 资源时间线关联档位（50/100/150 三段各自峰值）
#   [4] threshold 导出语义核对（逐条列出 pass/fail）
#   [5] 连接池分母与占用采集（Hikari JMX 或日志推算）
set -euo pipefail
STAGE_DIR="${1:-/opt/schema/staging/perf-reverify}"
BASE_URL="http://127.0.0.1:18083"
mkdir -p "$STAGE_DIR"
TS() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
echo "[$(TS)] [run] 复验开始（修正口径）"

# 后端健康预检
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/auth/csrf" || echo 000)
[ "$CODE" = "200" ] || { echo "[FAIL] 压测后端不可用（csrf=$CODE）"; exit 2; }

# 资源采样器（1s 间隔）
cat > "$STAGE_DIR/sample.sh" <<'SHEOF'
#!/usr/bin/env bash
OUT="$1"
echo "ts,cpu_pct,mem_pct,pg_conn,pg_active,java_rss_mb" > "$OUT"
JAVA_PID=$(ss -ltnp | grep ':18083' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | head -1)
while true; do
  CPU=$(top -bn1 | awk '/Cpu\(s\)/{print 100 - $8}')
  MEM=$(free | awk '/Mem:/{printf "%.1f", $3/$2*100}')
  CONN=$(su - postgres -c "psql -p 15433 -Atc \"SELECT count(*) FROM pg_stat_activity WHERE datname='schema_perf'\"" 2>/dev/null || echo -1)
  ACTIVE=$(su - postgres -c "psql -p 15433 -Atc \"SELECT count(*) FROM pg_stat_activity WHERE datname='schema_perf' AND state='active'" 2>/dev/null || echo -1)
  RSS=$(ps -o rss= -p "$JAVA_PID" 2>/dev/null | awk '{print int($1/1024)}')
  echo "$(date +%s),$CPU,$MEM,$CONN,$ACTIVE,$RSS" >> "$OUT"
  sleep 1
done
SHEOF
chmod +x "$STAGE_DIR/sample.sh"
nohup bash "$STAGE_DIR/sample.sh" "$STAGE_DIR/resources.csv" > /dev/null 2>&1 &
SAMPLER_PID=$!
trap "kill $SAMPLER_PID 2>/dev/null || true" EXIT

# k6 复验（保留实际退出码）
echo "[$(TS)] [k6] ramping 50→100→150 VU（每档 2min）"
set +e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
k6 run -e BASE_URL="$BASE_URL" -e PASSWORD="${PERF_PASSWORD:?需注入}" -e MODEL_ID=1 \
  --summary-export="$STAGE_DIR/k6-reverify.json" \
  "${SCRIPT_DIR}/perf-reverify.js" 2>&1 | tee "$STAGE_DIR/reverify-console.log"
K6_EXIT=$?
set -e
kill $SAMPLER_PID 2>/dev/null || true
trap - EXIT
echo "[$(TS)] [k6] 实际退出码 K6_EXIT=$K6_EXIT"

# 档位资源峰值汇总（按时间窗切分：t0+30s~120s=50VU；150s~240s=100VU；270s~360s=150VU）
python3 - "$STAGE_DIR" "$K6_EXIT" <<'PYEOF'
import json, csv, sys, datetime
stage, k6_exit = sys.argv[1], int(sys.argv[2])
d = json.load(open(f"{stage}/k6-reverify.json"))
m = d["metrics"]
result = {"executedAt": datetime.datetime.utcnow().isoformat() + "Z", "k6ExitCode": k6_exit}
# 分接口 P95
for k in sorted(m):
    v = m[k]
    if isinstance(v, dict) and "p(95)" in v and ("type:" in k or k == "http_req_duration"):
        tag = k.split("type:")[-1].rstrip("}") if "type:" in k else "overall"
        result.setdefault("p95", {})[tag] = round(v["p(95)"], 1)
        result.setdefault("avg", {})[tag] = round(v.get("avg", 0), 1)
# 错误率（修正口径）
failed = m.get("http_req_failed", {})
reqs = m.get("http_reqs", {})
result["failedRate"] = failed.get("rate", 0) if isinstance(failed, dict) else None
result["totalReqs"] = reqs.get("count") if isinstance(reqs, dict) else None
# check 明细
checks = d.get("root_group", {}).get("checks", {})
result["checks"] = {name: {"passes": c.get("passes"), "fails": c.get("fails")} for name, c in checks.items()}
# threshold 判定（从控制台抓）
result["thresholds"] = []
for line in open(f"{stage}/reverify-console.log", encoding="utf-8", errors="ignore"):
    if "✓" in line and "p(95)" in line: result["thresholds"].append({"verdict": "PASS", "detail": line.strip()[:120]})
    if "✗" in line and ("p(95)" in line or "rate" in line): result["thresholds"].append({"verdict": "FAIL", "detail": line.strip()[:120]})
# 资源分档峰值
rows = list(csv.DictReader(open(f"{stage}/resources.csv")))
if rows:
    times = [int(r["ts"]) for r in rows]
    t0 = min(times)
    def peak(pred, col):
        vals = [float(r[col]) for r in rows if pred(int(r["ts"]) - t0)]
        return round(max(vals), 1) if vals else None
    levels = {}
    for name, lo, hi in [("50VU", 30, 120), ("100VU", 150, 240), ("150VU", 270, 360)]:
        levels[name] = {
            "cpuMax": peak(lambda t, lo=lo, hi=hi: lo <= t <= hi, "cpu_pct"),
            "memMax": peak(lambda t, lo=lo, hi=hi: lo <= t <= hi, "mem_pct"),
            "pgConnMax": peak(lambda t, lo=lo, hi=hi: lo <= t <= hi, "pg_conn"),
            "pgActiveMax": peak(lambda t, lo=lo, hi=hi: lo <= t <= hi, "pg_active"),
            "javaRssMax": peak(lambda t, lo=lo, hi=hi: lo <= t <= hi, "java_rss_mb"),
        }
    result["resourceByLevel"] = levels
json.dump(result, open(f"{stage}/reverify-result.json", "w"), indent=2, ensure_ascii=False)
print(json.dumps({k: result[k] for k in ["p95", "failedRate", "k6ExitCode"] if k in result}, ensure_ascii=False))
print(json.dumps(result.get("resourceByLevel", {}), ensure_ascii=False))
PYEOF
echo "[$(TS)] [done] $STAGE_DIR/reverify-result.json"
