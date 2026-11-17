#!/usr/bin/env bash
# M16 分档复验执行器：50/100/150 VU 各 3min steady（含发布负载独立 P95）
# 每档独立 threshold 判定 + 资源峰值关联 + 保留实际退出码
set -euo pipefail
STAGE_DIR="${1:-/opt/schema/staging/perf-levels}"
BASE_URL="http://127.0.0.1:18083"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$STAGE_DIR"
TS() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# 资源采样器
cat > "$STAGE_DIR/sample.sh" <<'SHEOF'
#!/usr/bin/env bash
OUT="$1"
echo "ts,cpu_pct,mem_pct,pg_conn,java_rss_mb" > "$OUT"
JAVA_PID=$(ss -ltnp | grep ':18083' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | head -1)
while true; do
  CPU=$(top -bn1 | awk '/Cpu\(s\)/{print 100 - $8}')
  MEM=$(free | awk '/Mem:/{printf "%.1f", $3/$2*100}')
  CONN=$(su - postgres -c "/usr/bin/psql -p 15433 -Atc \"SELECT count(*) FROM pg_stat_activity WHERE datname='schema_perf'\"" 2>/dev/null || echo -1)
  RSS=$(ps -o rss= -p "$JAVA_PID" 2>/dev/null | awk '{print int($1/1024)}')
  echo "$(date +%s),$CPU,$MEM,$CONN,$RSS" >> "$OUT"
  sleep 1
done
SHEOF
chmod +x "$STAGE_DIR/sample.sh"

for LEVEL in 50 100 150; do
  echo "[$(TS)] ===== LEVEL ${LEVEL}VU steady 180s ====="
  nohup bash "$STAGE_DIR/sample.sh" "$STAGE_DIR/resources-${LEVEL}.csv" > /dev/null 2>&1 &
  SAMPLER=$!
  set +e
  k6 run -e BASE_URL="$BASE_URL" -e PASSWORD="${PERF_PASSWORD:?}" -e MODEL_ID=1 \
    -e LEVEL_VUS=$LEVEL -e LEVEL_SECS=180 \
    --summary-export="$STAGE_DIR/k6-level${LEVEL}.json" \
    "$SCRIPT_DIR/perf-level-steady.js" 2>&1 | tee "$STAGE_DIR/console-${LEVEL}.log"
  EXIT_CODE=$?
  set -e
  kill $SAMPLER 2>/dev/null || true
  echo "[$(TS)] LEVEL ${LEVEL}VU exit=$EXIT_CODE"
  sleep 30   # 档间冷却，避免上一档残留连接污染下一档
done

# 汇总
python3 - "$STAGE_DIR" <<'PYEOF'
import json, csv, sys, datetime
stage = sys.argv[1]
result = {"executedAt": datetime.datetime.utcnow().isoformat() + "Z", "levels": {}}
for level in [50, 100, 150]:
    d = json.load(open(f"{stage}/k6-level{level}.json"))
    m = d["metrics"]
    lv = {}
    for k in sorted(m):
        v = m[k]
        if isinstance(v, dict) and "p(95)" in v and "type:" in k:
            tag = k.split("type:")[-1].rstrip("}")
            lv[tag] = {"p95": round(v["p(95)"], 1), "avg": round(v.get("avg", 0), 1)}
    failed = m.get("http_req_failed", {})
    reqs = m.get("http_reqs", {})
    lv["failedRate"] = failed.get("rate", 0) if isinstance(failed, dict) else None
    lv["totalReqs"] = reqs.get("count") if isinstance(reqs, dict) else None
    checks = d.get("root_group", {}).get("checks", {})
    lv["checks"] = {n: {"passes": c.get("passes"), "fails": c.get("fails")} for n, c in checks.items()}
    # threshold 判定
    thr = []
    for line in open(f"{stage}/console-{level}.log", encoding="utf-8", errors="ignore"):
        if "✓" in line and "p(95)" in line: thr.append({"verdict": "PASS", "detail": line.strip()[:110]})
        if "✗" in line and ("p(95)" in line or "rate" in line): thr.append({"verdict": "FAIL", "detail": line.strip()[:110]})
    lv["thresholds"] = thr
    # 资源峰值
    try:
        rows = list(csv.DictReader(open(f"{stage}/resources-{level}.csv")))
        if rows:
            lv["resource"] = {
                "cpuMax": round(max(float(r["cpu_pct"]) for r in rows), 1),
                "memMax": round(max(float(r["mem_pct"]) for r in rows), 1),
                "pgConnMax": round(max(float(r["pg_conn"]) for r in rows), 1),
                "javaRssMax": round(max(float(r["java_rss_mb"]) for r in rows), 1),
            }
    except Exception:
        pass
    result["levels"][f"{level}VU"] = lv
json.dump(result, open(f"{stage}/levels-result.json", "w"), indent=2, ensure_ascii=False)
print(json.dumps({k: {"p95": {t: v["p95"] for t, v in lv.items() if isinstance(v, dict) and "p95" in v},
                      "failedRate": lv.get("failedRate")} for k, lv in result["levels"].items()}, ensure_ascii=False))
PYEOF
echo "[$(TS)] [done] $STAGE_DIR/levels-result.json"
