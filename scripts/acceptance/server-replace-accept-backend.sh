#!/bin/bash
# 替换验收后端为最新受控构建：上传 JAR → 停旧实例 → 起实例(JDK21) → 身份核对
set -euo pipefail
cd /opt/schema/staging
J21=/usr/lib/jvm/java-21-konajdk-21.0.12-4.oc9/bin/java
OLD_PID=$(pgrep -f 'schema-platform-accept.jar' || true)
if [ -n "$OLD_PID" ]; then
  kill $OLD_PID
  for i in $(seq 1 20); do pgrep -f 'schema-platform-accept.jar' >/dev/null || break; sleep 1; done
fi
if [ -f /tmp/schema-platform-accept.jar ]; then
  mv schema-platform-accept.jar schema-platform-accept.jar.bak 2>/dev/null || true
  cp /tmp/schema-platform-accept.jar schema-platform-accept.jar
  rm -f /tmp/schema-platform-accept.jar
fi
NEW_SHA=$(sha256sum schema-platform-accept.jar | cut -d' ' -f1)
echo "NEW_JAR_SHA=$NEW_SHA"
nohup /usr/lib/jvm/java-21-konajdk-21.0.12-4.oc9/bin/java -Xms128m -Xmx512m -jar schema-platform-accept.jar \
  --server.port=18081 \
  --spring.datasource.url='jdbc:postgresql://127.0.0.1:5432/schema_acceptance' \
  --spring.datasource.username=schema_accept \
  --spring.datasource.password='schema_accept_only_2026' \
  > schema-accept.log 2>&1 &
echo "STARTED pid=$!"
# 等就绪（任意 HTTP 响应即活——actuator 需鉴权）
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:18081/api/system/build-identity || true)
  if [ "$code" != "000" ] && [ -n "$code" ]; then echo "READY http=$code"; break; fi
  sleep 2
done
