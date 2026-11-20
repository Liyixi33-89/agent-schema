#!/usr/bin/env bash
# 验收面状态检查（只读）
echo "== current =="
readlink /opt/schema/staging/accept/current || echo "<none>"
echo "== app links =="
for app in designer runtime admin; do
  printf '%-10s ' "$app"
  readlink "/opt/schema/staging/accept/$app" || echo "<missing>"
done
echo "== probe =="
curl -s -m 5 http://127.0.0.1:18081/internal/health/readiness || echo "<unreachable>"
echo
echo "== entries =="
for p in /accept/designer/ /accept/runtime/ /accept/admin/; do
  printf '%-22s -> ' "$p"
  curl -s -o /dev/null -w '%{http_code}\n' -m 8 "http://127.0.0.1$p"
done
echo "== backend log tail =="
tail -5 /opt/schema/staging/accept/backend.log 2>/dev/null || echo "<no log>"