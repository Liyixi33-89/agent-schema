#!/bin/bash
# M16 T4 fault drill — adapted to perf env (backend 18083, dedicated test PG 15433/schema_perf)
# Never touches prod (18080) or accept (18081) or prod PG (5432)
set -uo pipefail
STAGE_DIR="${1:-/opt/schema/staging/fault-drill}"
TARGET="${TARGET:-http://127.0.0.1:18083}"
PG_PORT=15433
PG_DB=schema_perf
BACKEND_PID_FILE=/opt/schema/staging/perf-backend.pid
RESTART_CMD="/usr/lib/jvm/java-21-konajdk-21.0.12-4.oc9/bin/java -Xms256m -Xmx768m -jar /opt/schema/staging/schema-platform-perf.jar --server.port=18083 --spring.datasource.url=jdbc:postgresql://127.0.0.1:15433/schema_perf --spring.datasource.username=schema_perf --spring.datasource.password=perf_pg_2026"
TIMELINE="$STAGE_DIR/timeline.jsonl"
mkdir -p "$STAGE_DIR"
TS() { date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"; }
LOG() { echo "{\"at\":\"$(TS)\",\"event\":\"$1\",\"detail\":$2}" >> "$TIMELINE"; echo "[$(TS)] $1 $2"; }
pg() { su - postgres -c "/usr/bin/psql -p $PG_PORT -d $PG_DB $*"; }
probe() {
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$TARGET/api/ops/health" 2>/dev/null || echo 000)
  [ "$CODE" != "000" ]
}
wait_alive() {
  local i=0
  while [ $i -lt 45 ]; do
    probe && return 0
    i=$((i+1)); sleep 2
  done
  return 1
}
login_probe() { # authenticated business probe: login + query (validates recovery beyond health)
  local JAR=$(mktemp)
  curl -s -c "$JAR" "$TARGET/api/auth/csrf" -o /dev/null
  local C=$(grep schema_csrf "$JAR" | awk '{print $7}')
  curl -s -b "$JAR" -c "$JAR" -X POST "$TARGET/api/auth/login" -H 'Content-Type: application/json' -H "Origin: $TARGET" -H "X-CSRF-Token: $C" -d '{"username":"accept_admin","password":"Accept!2026"}' -o /dev/null
  C=$(grep schema_csrf "$JAR" | awk '{print $7}')
  local CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$TARGET/api/data/1/query" -H 'Content-Type: application/json' -H "Origin: $TARGET" -H "X-CSRF-Token: $C" -d '{"page":1,"size":5}')
  rm -f "$JAR"
  echo "$CODE"
}

# ========== TC-FT-01 connection pool exhaustion ==========
ft01() {
  LOG "ft01_start" '{"scenario":"hikari pool exhaustion (occupy PG conns)"}'
  # occupy 20 PG conns with idle-in-transaction (Hikari default max 10)
  for i in $(seq 1 20); do
    ( pg -c "BEGIN; SELECT pg_sleep(60);" >/dev/null 2>&1 ) &
  done
  sleep 12
  local CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$TARGET/api/ops/health")
  local QCODE=$(login_probe)
  LOG "ft01_observe" "{\"healthCode\":$CODE,\"queryCode\":$QCODE}"
  # cleanup
  pg -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$PG_DB' AND state='idle in transaction'" >/dev/null 2>&1 || true
  pkill -f "pg_sleep(60)" 2>/dev/null || true
  sleep 6
  local Q2=$(login_probe)
  if probe && [ "$Q2" = "200" ]; then LOG "ft01_recovered" "{\"queryCode\":$Q2}"; else LOG "ft01_recover_failed" "{\"queryCode\":$Q2}"; fi
}

# ========== TC-FT-02 slow query (lock) ==========
ft02() {
  LOG "ft02_start" '{"scenario":"row lock blocks writes 30s"}'
  # exclusive lock on one row -> business writes to other rows must still succeed
  ( pg -c "BEGIN; SELECT * FROM biz_model_1 WHERE id=(SELECT min(id) FROM biz_model_1) FOR UPDATE; SELECT pg_sleep(30);" >/dev/null 2>&1 ) &
  sleep 8
  local QCODE=$(login_probe)
  LOG "ft02_observe" "{\"queryCode\":$QCODE,\"note\":\"single-row lock, other-row queries must be unaffected\"}"
  wait
  sleep 3
  local Q2=$(login_probe)
  if [ "$Q2" = "200" ]; then LOG "ft02_recovered" "{\"queryCode\":$Q2}"; else LOG "ft02_recover_failed" "{\"queryCode\":$Q2}"; fi
}

# ========== TC-FT-04 process kill -9 ==========
ft04() {
  LOG "ft04_start" '{"scenario":"kill -9 backend, restart, measure RTO"}'
  # resolve REAL pid by port (pid file may be stale after external restarts)
  local PID=$(ss -tlnp | grep ':18083 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  [ -z "$PID" ] && PID=$(cat "$BACKEND_PID_FILE" 2>/dev/null)
  [ -z "$PID" ] && { LOG "ft04_skip" '{"reason":"no backend process"}'; return 0; }
  local T0=$(date +%s)
  kill -9 "$PID"
  sleep 3
  probe && LOG "ft04_observe" '{"unexpected":"still alive"}' || LOG "ft04_observe" '{"expected":"dead"}'
  LOG "ft04_recover_start" '{"action":"manual restart (systemd-equivalent for perf env)"}'
  nohup $RESTART_CMD > /opt/schema/staging/perf-backend.log 2>&1 &
  echo $! > "$BACKEND_PID_FILE"
  # business-ready probe: health alive AND query 200 (not just port listening)
  local QCODE=000
  for i in $(seq 1 45); do
    QCODE=$(login_probe)
    [ "$QCODE" = "200" ] && break
    sleep 2
  done
  if [ "$QCODE" = "200" ]; then
    local T1=$(date +%s)
    LOG "ft04_recovered" "{\"rtoSeconds\":$((T1 - T0)),\"queryCode\":$QCODE}"
  else
    LOG "ft04_recover_failed" "{\"queryCode\":$QCODE}"
  fi
}

# ========== TC-UP-02 flyway migration failure blocks startup ==========
up02() {
  LOG "up02_start" '{"scenario":"bad migration must block startup"}'
  # extract jar, inject V999 bad sql, restart -> must FAIL to start; then restore
  local PID=$(cat "$BACKEND_PID_FILE" 2>/dev/null)
  kill "$PID" 2>/dev/null || true
  sleep 5
  cd /tmp
  rm -rf perfjar && mkdir perfjar && cd perfjar
  # jar tool lives in java-17 on this host; use it to repack
  JARTOOL=$(ls /usr/lib/jvm/*/bin/jar 2>/dev/null | head -1)
  "$JARTOOL" -xf /opt/schema/staging/schema-platform-perf.jar >/dev/null 2>&1
  echo "THIS IS NOT VALID SQL;" > BOOT-INF/classes/db/migration/V999__drill_fail.sql
  "$JARTOOL" -cf /tmp/schema-platform-perf-bad.jar . >/dev/null 2>&1
  # start with bad jar -> expect FAIL (Flyway blocks)
  local T0=$(date +%s)
  nohup /usr/lib/jvm/java-21-konajdk-21.0.12-4.oc9/bin/java -Xms256m -Xmx768m -jar /tmp/schema-platform-perf-bad.jar --server.port=18083 --spring.datasource.url=jdbc:postgresql://127.0.0.1:15433/schema_perf --spring.datasource.username=schema_perf --spring.datasource.password=perf_pg_2026 > /opt/schema/staging/perf-backend-bad.log 2>&1 &
  local BADPID=$!
  local BLOCKED=0
  for i in $(seq 1 40); do
    if grep -q "Migration.*failed\|APPLICATION FAILED TO START\|Error executing statement" /opt/schema/staging/perf-backend-bad.log 2>/dev/null; then
      BLOCKED=1; break
    fi
    # if it actually became alive => migration NOT blocking => FAIL
    if curl -s -o /dev/null --max-time 2 "$TARGET/api/ops/health" 2>/dev/null; then
      BLOCKED=0; break
    fi
    sleep 2
  done
  if [ "$BLOCKED" = "1" ]; then
    LOG "up02_blocked_as_expected" '{"migration":"V999 failed -> startup blocked, no half-upgrade"}'
  else
    LOG "up02_VIOLATION" '{"migration":"bad migration did NOT block startup"}'
  fi
  kill -9 "$BADPID" 2>/dev/null || true
  # restore good jar
  nohup $RESTART_CMD > /opt/schema/staging/perf-backend.log 2>&1 &
  echo $! > "$BACKEND_PID_FILE"
  wait_alive && LOG "up02_restored" '{"probe":"alive"}' || LOG "up02_restore_failed" '{"probe":"dead"}'
  rm -rf /tmp/perfjar /tmp/schema-platform-perf-bad.jar
}

echo "[$(TS)] fault drill on perf env (18083/15433) — never touches prod"
LOG "drill_start" "{\"target\":\"$TARGET\"}"
ft04
up02
LOG "drill_end" '{"scenarios":["ft04","up02"]}'
echo "[$(TS)] drill done — timeline: $TIMELINE"
