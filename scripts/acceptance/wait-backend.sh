#!/bin/bash
# 等验收后端就绪（探活口径：任何 HTTP 响应（含 401/404）即活——actuator 需鉴权，200 判定会误报）
probe() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:18080/api/auth/csrf; }
for i in $(seq 1 30); do
  code=$(probe)
  if [ "$code" != "000" ] && [ -n "$code" ]; then echo "READY try=$i code=$code"; exit 0; fi
  sleep 3
done
echo "TIMEOUT — restarting backend"
JAR=$(ls /mnt/c/Users/v_liyixili/Desktop/2026/schema/schema-platform/bootstrap/target/*.jar 2>/dev/null | grep -v original | head -1)
setsid env DB_URL='jdbc:postgresql://localhost:5432/schema_accept' DB_USER=schema_dev DB_PASSWORD=schema_local_only SERVER_PORT=18080 nohup java -jar "$JAR" > /tmp/schema-accept.log 2>&1 &
disown || true
for i in $(seq 1 40); do
  code=$(probe)
  if [ "$code" != "000" ] && [ -n "$code" ]; then echo "READY-after-restart try=$i code=$code"; exit 0; fi
  sleep 3
done
echo "FAILED"; exit 1
