#!/bin/bash
# M12 验收环境启动（WSL 内执行）：后端 18080（schema_accept 库）+ 静态代理 8090
# 后台进程须 setsid + disown 保活（wsl.exe 会话退出即回收——坑位见 MEMORY）
set -e
cd "$(dirname "$0")"

# 0) 后端 jar 定位（bootstrap/target）
JAR=$(ls /mnt/c/Users/v_liyixili/Desktop/2026/schema/schema-platform/bootstrap/target/*.jar 2>/dev/null | grep -v original | head -1)
if [ -z "$JAR" ]; then echo "JAR not found — run mvn package first" >&2; exit 1; fi
echo "JAR=$JAR"

# 1) 端口占用检查（幂等重启）
if curl -s -o /dev/null http://127.0.0.1:18080/actuator/health; then
  echo "backend already up"; else
  setsid env DB_URL='jdbc:postgresql://localhost:5432/schema_accept' DB_USER=schema_dev DB_PASSWORD=schema_local_only \
    SERVER_PORT=18080 nohup java -jar "$JAR" > /tmp/schema-accept.log 2>&1 &
  disown || true
  echo "backend starting..."
fi

# 2) 静态代理 8090 在 Windows 侧运行（WSL 无 node）：
#    powershell.exe -Command "Start-Process node -ArgumentList 'scripts\acceptance\serve-acceptance.cjs' -WindowStyle Hidden"

# 3) 等待就绪
for i in $(seq 1 60); do
  if curl -s -o /dev/null http://127.0.0.1:18080/actuator/health && curl -s -o /dev/null http://127.0.0.1:8090/designer/; then
    echo "READY"; exit 0
  fi
  sleep 2
done
echo "TIMEOUT — check /tmp/schema-accept.log /tmp/accept-proxy.log" >&2
exit 1
