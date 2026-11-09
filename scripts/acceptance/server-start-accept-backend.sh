#!/bin/bash
# 启动独立验收后端：18081 + schema_acceptance 库；产物来自本地受控构建（a90305f）
set -euo pipefail
cd /opt/schema/staging
sha_expected="22b8c81336fa18a5f2f8a840e9d699d1dbbffc6396c482b6a9fc309a14f870c4"
sha_actual=$(sha256sum schema-platform-accept.jar | cut -d' ' -f1)
if [ "$sha_expected" != "$sha_actual" ]; then echo "HASH_MISMATCH"; exit 1; fi
if curl -s --max-time 3 -o /dev/null http://127.0.0.1:18081/api/system/build-identity; then echo "ALREADY_RUNNING"; exit 0; fi
nohup java -Xms128m -Xmx512m -jar schema-platform-accept.jar \
  --server.port=18081 \
  --spring.datasource.url='jdbc:postgresql://127.0.0.1:5432/schema_acceptance' \
  --spring.datasource.username=schema_accept \
  --spring.datasource.password='schema_accept_only_2026' \
  > schema-accept.log 2>&1 &
echo "STARTED pid=$!"
