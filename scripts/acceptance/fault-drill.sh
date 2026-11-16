#!/usr/bin/env bash
# M16 T4 故障注入与回滚演练（测试文档 03 §2/§3：TC-FT 01-06 + TC-UP 01-04）
# 用途：预发布环境故障注入（连接池耗尽/慢查询/下游超时/实例退出）+ 恢复验证 + 告警触达记录。
# 铁律：
# - 每个场景独立函数：注入 → 观测 → 停止条件 → 清理 → 恢复探活
# - 只打预发布端口（TARGET 默认 18081），生产 18080 禁入
# - 告警触达验证须真实渠道（IM webhook/邮件），记录发出→触达时延
# - 演练时间线全部落档（timeline.jsonl）
set -uo pipefail

STAGE_DIR="${1:-/opt/schema/staging/fault-drill}"
TARGET="${TARGET:-http://127.0.0.1:18081}"   # 预发布后端（禁指生产）
PG_DB="${PG_DB:-schema_perf}"
TIMELINE="$STAGE_DIR/timeline.jsonl"
ALERT_WEBHOOK="${ALERT_WEBHOOK:-}"           # 告警渠道（IM webhook——值班触达验证用）

mkdir -p "$STAGE_DIR"
TS() { date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"; }
LOG() { echo "{\"at\":\"$(TS)\",\"event\":\"$1\",\"detail\":$2}" >> "$TIMELINE"; echo "[$(TS)] $1 $2"; }

# 探活：任意 HTTP 响应即活（actuator 需鉴权——200 判定会误报死活）
probe() {
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$TARGET/api/ops/health" 2>/dev/null || echo 000)
  [ "$CODE" != "000" ]
}
wait_alive() {
  local i=0
  while [ $i -lt 60 ]; do
    probe && return 0
    i=$((i+1)); sleep 2
  done
  return 1
}

# 告警发送（触达链路演练——记录发送时刻）
send_alert() {
  local level="$1" msg="$2"
  LOG "alert_send" "{\"level\":\"$level\",\"msg\":\"$msg\",\"webhookConfigured\":$([ -n "$ALERT_WEBHOOK" ] && echo true || echo false)}"
  if [ -n "$ALERT_WEBHOOK" ]; then
    curl -s -X POST "$ALERT_WEBHOOK" -H 'Content-Type: application/json' \
      -d "{\"level\":\"$level\",\"text\":\"[DR-FT 演练] $msg\",\"at\":\"$(TS)\"}" \
      > "$STAGE_DIR/alert-send-$(date +%s).json" 2>&1 || true
  fi
}

# ========== TC-FT-01 连接池耗尽 ==========
ft01_pool_exhaust() {
  LOG "ft01_start" '{"scenario":"connection pool exhaustion"}'
  # 占满 PG 连接（默认池 10）：建 15 个长事务连接
  local PIDS=()
  for i in $(seq 1 15); do
    su - postgres -c "psql -d $PG_DB -c 'BEGIN; SELECT 1;' &" >/dev/null 2>&1 &
    PIDS+=($!)
  done
  sleep 10
  # 观测：应用仍能响应（池耗尽应排队/超时而非崩溃）
  local CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$TARGET/api/ops/health")
  LOG "ft01_observe" "{\"healthCode\":$CODE}"
  send_alert "P1" "TC-FT-01 连接池耗尽注入：健康接口响应 $CODE"
  # 清理：释放占用连接
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  su - postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$PG_DB' AND state='idle in transaction'" >/dev/null 2>&1 || true
  sleep 5
  wait_alive && LOG "ft01_recovered" '{"probe":"alive"}' || LOG "ft01_recover_failed" '{"probe":"dead"}'
}

# ========== TC-FT-02 慢查询注入 ==========
ft02_slow_query() {
  LOG "ft02_start" '{"scenario":"slow query injection"}'
  # 锁表制造慢查询（业务表写阻塞 30s）
  su - postgres -c "psql -d $PG_DB -c \"BEGIN; UPDATE data_engine_record SET data=data WHERE id=(SELECT min(id) FROM data_engine_record); \" &" >/dev/null 2>&1 &
  local LOCK_PID=$!
  sleep 20
  local T0=$(date +%s%N)
  local CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$TARGET/api/ops/health")
  local T1=$(date +%s%N)
  local LATENCY_MS=$(( (T1 - T0) / 1000000 ))
  LOG "ft02_observe" "{\"healthCode\":$CODE,\"latencyMs\":$LATENCY_MS}"
  send_alert "P2" "TC-FT-02 慢查询注入：健康接口 ${LATENCY_MS}ms"
  kill "$LOCK_PID" 2>/dev/null || true
  su - postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$PG_DB' AND wait_event_type='Lock'" >/dev/null 2>&1 || true
  wait_alive && LOG "ft02_recovered" '{"probe":"alive"}' || LOG "ft02_recover_failed" '{"probe":"dead"}'
}

# ========== TC-FT-04 实例退出（进程 kill） ==========
ft04_process_kill() {
  LOG "ft04_start" '{"scenario":"backend process kill -9"}'
  local PID=$(pgrep -f "schema.*\.jar" | head -1)
  if [ -z "$PID" ]; then
    LOG "ft04_skip" '{"reason":"no backend process found"}'
    return 0
  fi
  send_alert "P0" "TC-FT-04 后端进程即将被 kill -9（演练注入）"
  kill -9 "$PID"
  sleep 3
  probe && LOG "ft04_observe" '{"unexpected":"still alive"}' || LOG "ft04_observe" '{"expected":"dead"}'
  # 恢复：由 systemd/脚本重启（演练环境手动拉起）
  LOG "ft04_recover_start" '{"action":"restart backend"}'
  # 占位：实际重启命令由环境注入（RESTART_CMD）
  if [ -n "${RESTART_CMD:-}" ]; then
    bash -c "$RESTART_CMD"
    wait_alive && LOG "ft04_recovered" '{"probe":"alive","rtoSeconds":'$(( $(date +%s) - $(date -d @$(stat -c %Y /proc/$PID 2>/dev/null || echo 0) +%s) ))'}' \
      || LOG "ft04_recover_failed" '{"probe":"dead"}'
  else
    LOG "ft04_manual_restart_required" '{"note":"RESTART_CMD 未配置——人工重启后复跑探活"}'
  fi
}

# ========== TC-UP-02 Flyway 迁移失败阻断 ==========
up02_migration_block() {
  LOG "up02_start" '{"scenario":"flyway migration failure blocks deploy"}'
  # 制造必然失败的迁移（V999 坏 SQL）→ 启动应阻断（应用不起来，不半升级）
  cat > /tmp/V999__drill_fail.sql <<'EOF'
THIS IS NOT VALID SQL; -- 演练：迁移失败必须阻断发布
EOF
  # 由部署脚本注入 migration 目录后启动——此处记录场景与判定口径
  LOG "up02_instruction" '{"manual":"将 V999__drill_fail.sql 放入 migration 目录→重启后端→必须启动失败且旧版本仍可服务"}'
  rm -f /tmp/V999__drill_fail.sql
}

# ========== 主流程 ==========
echo "[$(TS)] 故障演练准备就绪（目标：$TARGET）"
echo "  场景清单：TC-FT-01 连接池 / TC-FT-02 慢查询 / TC-FT-04 进程退出 / TC-UP-02 迁移阻断"
echo "  ⚠️ 执行前确认：TARGET 指向预发布（非生产 18080）；窗口与告警接收人已确认"
echo "  用法：fault-drill.sh <stage_dir> [ft01|ft02|ft04|up02|all]"
SCENARIO="${2:-all}"
LOG "drill_start" "{\"target\":\"$TARGET\",\"scenario\":\"$SCENARIO\"}"
case "$SCENARIO" in
  ft01) ft01_pool_exhaust ;;
  ft02) ft02_slow_query ;;
  ft04) ft04_process_kill ;;
  up02) up02_migration_block ;;
  all)
    ft01_pool_exhaust
    ft02_slow_query
    ft04_process_kill
    up02_migration_block
    ;;
  *) echo "未知场景：$SCENARIO"; exit 1 ;;
esac
LOG "drill_end" "{\"scenario\":\"$SCENARIO\",\"timeline\":\"$TIMELINE\"}"
echo "[$(TS)] 演练结束——时间线：$TIMELINE"
echo "  后续：人工核对告警实际触达（发送时刻 vs 值班收到时刻）→ 触达时延入报告"
