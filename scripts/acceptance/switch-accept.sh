#!/usr/bin/env bash
# 验收面切换（幂等）：切软链 + 重启后端 + 等就绪
set -uo pipefail
HEAD="${1:?usage: switch-accept.sh <commit>}"
ROOT=/opt/schema/staging/accept
JAVA=/usr/lib/jvm/jre-21-konajdk/bin/java

[ -d "$ROOT/releases/$HEAD" ] || { echo "missing release: $HEAD"; exit 1; }

ln -sfn "$ROOT/releases/$HEAD" "$ROOT/current"
for app in designer runtime admin; do
  rm -rf "$ROOT/$app"
  ln -sfn "$ROOT/current/web/$app" "$ROOT/$app"
done
echo "links switched to $HEAD"

# ⚠️ 进程名是 schema-platform.jar（不是 schema-platform-accept.jar）——
#    按端口精确匹配，避免误杀生产面（18080）与 perf 面（18083）
OLD_PIDS=$(ss -lntp 2>/dev/null | grep ':18081 ' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)
if [ -n "$OLD_PIDS" ]; then
  echo "stopping old backend: $OLD_PIDS"
  kill $OLD_PIDS 2>/dev/null || true
  sleep 3
  kill -9 $OLD_PIDS 2>/dev/null || true
  sleep 1
fi

cd "$ROOT/current" || exit 1
APP_VERSION="$HEAD" GIT_COMMIT="$HEAD" nohup "$JAVA" -jar schema-platform.jar \
  --server.port=18081 \
  --spring.datasource.url=jdbc:postgresql://127.0.0.1:5432/schema_acceptance \
  --spring.datasource.username=schema_accept \
  --spring.datasource.password=schema_accept_only_2026 \
  > "$ROOT/backend.log" 2>&1 &
echo "backend pid=$!"

for i in $(seq 1 40); do
  sleep 3
  if curl -sf -m 3 http://127.0.0.1:18081/internal/health/readiness >/dev/null 2>&1; then
    echo "READY after $((i*3))s"
    curl -s http://127.0.0.1:18081/internal/health/readiness
    echo
    exit 0
  fi
done
echo "NOT READY — log tail:"
tail -30 "$ROOT/backend.log"
exit 1