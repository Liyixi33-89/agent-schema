#!/usr/bin/env bash
# 启动验收后端（前台试跑 20s 抓错误，再转后台）
set -uo pipefail
cd /opt/schema/staging/accept/current || exit 1
HEAD=$(grep '^commit=' VERSION.txt | cut -d= -f2)
echo "commit=$HEAD"
pkill -f 'schema-platform-accept.jar' 2>/dev/null || true
sleep 2
APP_VERSION="$HEAD" GIT_COMMIT="$HEAD" nohup java -jar schema-platform.jar \
  --server.port=18081 \
  --spring.datasource.url=jdbc:postgresql://127.0.0.1:5432/schema_acceptance \
  --spring.datasource.username=schema_accept \
  --spring.datasource.password=schema_accept_only_2026 \
  > /opt/schema/staging/accept/backend.log 2>&1 &
echo "pid=$!"
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
tail -40 /opt/schema/staging/accept/backend.log
exit 1