#!/usr/bin/env bash
# 按端口精确停止验收后端（18081），避免误杀生产面 18080 / perf 面 18083
set -uo pipefail
PORT="${1:-18081}"
PIDS=$(ss -lntp 2>/dev/null | grep ":$PORT " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | sort -u)
if [ -z "$PIDS" ]; then
  echo "port $PORT free"
  exit 0
fi
echo "stopping: $PIDS"
kill $PIDS 2>/dev/null || true
sleep 3
kill -9 $PIDS 2>/dev/null || true
sleep 1
ss -lntp 2>/dev/null | grep ":$PORT " || echo "port $PORT free"