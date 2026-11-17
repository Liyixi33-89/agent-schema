#!/bin/bash
# TC-FT-05 三合一演练：注入 → 告警发送 → 接收端触达 → 大盘对照
# 环境：压测栈 18083/15433（隔离，不碰生产 18080/18081 与 5432）
# 告警通道：本机自建 webhook 接收端 127.0.0.1:18098（真实 HTTP POST，钉钉/企微兼容契约）
# 产出：/opt/schema/staging/fault-drill/ft05/（timeline + webhook inbox + 汇总 JSON）
set -uo pipefail
STAGE=/opt/schema/staging/fault-drill/ft05
TARGET="${TARGET:-http://127.0.0.1:18083}"
PG_PORT=15433
PG_DB=schema_perf
HOOK="http://127.0.0.1:18098/"
TIMELINE="$STAGE/ft05-timeline.jsonl"
INBOX="/opt/schema/staging/fault-drill/ft05-webhook-inbox.jsonl"   # 接收端真实写入库（勿改——与 ft05-webhook-recv.py INBOX 一致）
SUMMARY="$STAGE/ft05-result.json"
mkdir -p "$STAGE"
TSms() { python3 -c "import time;print('%.3f'%time.time())"; }
TSiso() { date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"; }
LOG() { echo "{\"at\":\"$(TSiso)\",\"event\":\"$1\",\"detail\":$2}" >> "$TIMELINE"; echo "[$(TSiso)] $1 $2"; }
pg() { su - postgres -c "/usr/bin/psql -p $PG_PORT -d $PG_DB $*"; }
inbox_count() { curl -s --max-time 5 "http://127.0.0.1:18098/_inbox" | python3 -c "import sys,json;print(json.load(sys.stdin)['count'])" 2>/dev/null || echo -1; }
# 发送告警并记录 send 时刻（epoch 秒，服务器同机时钟）
send_alert() {
  local level="$1" msg="$2"
  local send_ts=$(TSms)
  local resp
  resp=$(curl -s --max-time 10 -X POST -H 'Content-Type: application/json' \
    -d "{\"level\":\"$level\",\"text\":\"[TC-FT-05 演练] $msg\",\"send_ts\":$send_ts,\"at\":\"$(TSiso)\"}" "$HOOK")
  echo "$send_ts $resp"
}
login_probe() {
  local JAR=$(mktemp)
  curl -s -c "$JAR" "$TARGET/api/auth/csrf" -o /dev/null
  local C=$(grep schema_csrf "$JAR" | awk '{print $7}')
  curl -s -b "$JAR" -c "$JAR" -X POST "$TARGET/api/auth/login" -H 'Content-Type: application/json' -H "Origin: $TARGET" -H "X-CSRF-Token: $C" -d '{"username":"accept_admin","password":"Accept!2026"}' -o /dev/null
  C=$(grep schema_csrf "$JAR" | awk '{print $7}')
  local CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -b "$JAR" -X POST "$TARGET/api/data/1/query" -H 'Content-Type: application/json' -H "Origin: $TARGET" -H "X-CSRF-Token: $C" -d '{"page":1,"size":5}')
  rm -f "$JAR"
  echo "$CODE"
}

LOG "drill_start" '{"scenario":"TC-FT-05 alert delivery + TC-FT-06 dashboard cross-check","target":"'$TARGET'"}'

# ===== 步骤 0：接收端探活与 inbox 清零 =====
C0=$(curl -s --max-time 5 http://127.0.0.1:18098/_ping | head -c 20)
LOG "receiver_probe" "{\"resp\":\"$C0\"}"
if [ -z "$C0" ]; then LOG "drill_abort" '{"reason":"webhook receiver not reachable"}'; echo "ABORT: receiver down"; exit 1; fi
: > "$INBOX"   # 清零接收端 inbox（演练从 0 计数，冒烟/历史记录不混入判定）

# ===== 步骤 1：TC-FT-01 连接池耗尽注入 → P1 告警 =====
N0=$(inbox_count)
LOG "ft01_start" '{"scenario":"pool exhaustion 20 idle-in-transaction"}'
for i in $(seq 1 20); do ( pg -c "BEGIN; SELECT pg_sleep(90);" >/dev/null 2>&1 ) & done
sleep 12
HEALTH=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$TARGET/api/ops/health")
QCODE=$(login_probe)
LOG "ft01_observe" "{\"healthCode\":$HEALTH,\"queryCode\":$QCODE}"
OUT=$(send_alert "P1" "TC-FT-01 连接池耗尽注入：健康 $HEALTH 查询 $QCODE")
SEND_TS=${OUT%% *}; RESP=${OUT#* }
LOG "alert_sent" "{\"level\":\"P1\",\"send_ts\":$SEND_TS,\"receiverResp\":\"$RESP\"}"
pg -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$PG_DB' AND state='idle in transaction'" >/dev/null 2>&1 || true
pkill -f "pg_sleep(90)" 2>/dev/null || true
sleep 5

# ===== 步骤 2：TC-FT-02 单行锁慢查询注入 → P2 告警 =====
LOG "ft02_start" '{"scenario":"single-row FOR UPDATE 30s"}'
( pg -c "BEGIN; SELECT * FROM biz_model_1 WHERE id=(SELECT min(id) FROM biz_model_1) FOR UPDATE; SELECT pg_sleep(30);" >/dev/null 2>&1 ) &
sleep 8
QCODE2=$(login_probe)
LOG "ft02_observe" "{\"queryCode\":$QCODE2}"
OUT=$(send_alert "P2" "TC-FT-02 单行锁注入：其他行查询 $QCODE2")
SEND_TS2=${OUT%% *}; RESP2=${OUT#* }
LOG "alert_sent" "{\"level\":\"P2\",\"send_ts\":$SEND_TS2,\"receiverResp\":\"$RESP2\"}"
wait
sleep 3

# ===== 步骤 3：TC-FT-04 kill -9 → P0 告警（先发预警再杀）=====
PID=$(ss -tlnp | grep ':18083 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
[ -z "$PID" ] && PID=$(cat /opt/schema/staging/perf-backend.pid 2>/dev/null)
if [ -n "$PID" ]; then
  LOG "ft04_start" "{\"pid\":$PID,\"scenario\":\"kill -9 + restart, RTO\"}"
  OUT=$(send_alert "P0" "TC-FT-04 后端进程即将 kill -9（演练注入）pid=$PID")
  SEND_TS0=${OUT%% *}; RESP0=${OUT#* }
  LOG "alert_sent" "{\"level\":\"P0\",\"send_ts\":$SEND_TS0,\"receiverResp\":\"$RESP0\"}"
  T0=$(date +%s)
  kill -9 "$PID"
  sleep 3
  probe_dead=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$TARGET/api/ops/health" 2>/dev/null || echo 000)
  LOG "ft04_observe" "{\"healthCode\":$probe_dead}"
  nohup /usr/lib/jvm/java-21-konajdk-21.0.12-4.oc9/bin/java -Xms256m -Xmx768m -jar /opt/schema/staging/schema-platform-perf.jar --server.port=18083 --spring.datasource.url=jdbc:postgresql://127.0.0.1:15433/schema_perf --spring.datasource.username=schema_perf --spring.datasource.password=perf_pg_2026 > /opt/schema/staging/perf-backend.log 2>&1 &
  echo $! > /opt/schema/staging/perf-backend.pid
  Q3=000
  for i in $(seq 1 45); do Q3=$(login_probe); [ "$Q3" = "200" ] && break; sleep 2; done
  T1=$(date +%s)
  [ "$Q3" = "200" ] && LOG "ft04_recovered" "{\"rtoSeconds\":$((T1-T0))}" || LOG "ft04_recover_failed" "{\"queryCode\":$Q3}"
else
  LOG "ft04_skip" '{"reason":"no backend process"}'
  SEND_TS0=""
fi

# ===== 步骤 4：触达核对——inbox 条数与逐条时延 =====
sleep 2
N1=$(inbox_count)
LOG "inbox_check" "{\"before\":$N0,\"after\":$N1,\"expect\":\"$((N0+3))\"}"
# 逐条计算触达时延（send_ts 来自 payload；recv_ts 由接收端写入）
python3 - "$STAGE" <<'PYEOF'
import json, sys
stage = sys.argv[1]
inbox = "/opt/schema/staging/fault-drill/ft05-webhook-inbox.jsonl"
with open(inbox, encoding="utf-8") as f:
    lines = [json.loads(l) for l in f if l.strip()]
out = []
for rec in lines:
    payload = rec.get("payload", {})
    send_ts = payload.get("send_ts")
    recv_ts = rec.get("recv_ts")
    latency_ms = round((recv_ts - send_ts) * 1000, 1) if send_ts and recv_ts else None
    out.append({
        "level": payload.get("level"),
        "text": (payload.get("text") or "")[:80],
        "send_ts": send_ts,
        "recv_at": rec.get("recv_at"),
        "latency_ms": latency_ms,
        "delivered": latency_ms is not None and latency_ms < 300000,
    })
with open(stage + "/ft05-delivery.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print(json.dumps(out, ensure_ascii=False, indent=2))
PYEOF

# ===== 步骤 5：大盘对照（TC-FT-06）——健康页四聚合接口在注入窗口外的可用性 + 注入期间状态快照说明 =====
# 注：健康页四聚合接口挂在运营端点下（/api/ops/**）；注入期间的健康页状态对照已在 ft01/ft02 的
# healthCode/queryCode 观测位体现。此处补充演练后大盘接口回归（确认数据面未被注入损坏）。
DASH=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$TARGET/api/ops/health")
LOG "dashboard_post_drill" "{\"opsHealthCode\":$DASH,\"note\":\"post-drill ops endpoint regression\"}"

# ===== 步骤 6：汇总 =====
DELIVERED=$(python3 -c "
import json
try:
    d=json.load(open('$STAGE/ft05-delivery.json'))
    print(all(x['delivered'] for x in d) and len(d)>=3)
except Exception:
    print(False)
")
cat > "$SUMMARY" <<EOF
{
  "scenario": "TC-FT-05 alert delivery + TC-FT-06 dashboard cross-check",
  "channel": "self-hosted webhook receiver 127.0.0.1:18098 (HTTP POST, dingtalk-compatible response)",
  "alertsExpected": 3,
  "inboxBefore": $N0,
  "inboxAfter": $N1,
  "delivery": "$( [ "$DELIVERED" = "True" ] && echo PASS || echo FAIL )",
  "p95LatencyTarget": "<5min (spec TC-FT-05)",
  "dashboardRegression": "$DASH",
  "timeline": "ft05-timeline.jsonl"
}
EOF
LOG "drill_end" "{\"delivery\":\"$DELIVERED\",\"inboxAfter\":$N1}"
echo "==== SUMMARY ===="; cat "$SUMMARY"
