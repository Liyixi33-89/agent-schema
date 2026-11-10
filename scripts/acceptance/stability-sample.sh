# stability 采样（自动探测版）：验收动作前后响应一致性 + 本地重建确定性（双构建实测比对）
# - 同一部署在补验套件运行前后行为一致（对同一探针接口的响应哈希不变）
# - 本地产物哈希在「删除后重建」后不变——两次独立构建实测比对，禁止单点哈希冒充确定性
# - API 路由正确性探针：401 仅证明后端活；追加登录态真实请求（页面列表 200）证明验收 API 路由可达
# 输出 stability.json：禁止手填，全部实测。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SHA=$(git -C "$ROOT" rev-parse HEAD)
RUN_ID=${1:?用法: stability-sample.sh <runId>}
OUT="$ROOT/scripts/acceptance/out/$RUN_ID"
mkdir -p "$OUT"

probe_static() { curl -s "http://111.231.57.177/accept/designer/" | sha256sum | cut -d' ' -f1; }

echo "== before =="
B1=$(probe_static)
echo "static-before: $B1"

# WSL 内无 node——验收动作探针改用 curl 直连。401 只证明后端活且鉴权链正常；
# 登录态真实请求（页面列表 200）证明验收 API 路由正确可达。
C1=$(curl -s -o /dev/null -w '%{http_code}' http://111.231.57.177/accept/api/auth/csrf)
[ "$C1" = "401" ] || [ "$C1" = "200" ] || { echo "API PROBE FAIL: $C1"; exit 1; }
echo "api probe OK: $C1"
JAR=$(mktemp)
curl -s -c "$JAR" http://111.231.57.177/accept/api/auth/csrf -o /dev/null
CSRF=$(grep schema_csrf "$JAR" | awk '{print $7}')
curl -s -b "$JAR" -c "$JAR" -X POST http://111.231.57.177/accept/api/auth/login \
  -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF" \
  -H "Origin: http://111.231.57.177" \
  -d '{"username":"accept_admin","password":"Accept!2026"}' -o /dev/null
LIST_CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "http://111.231.57.177/accept/api/apps")
[ "$LIST_CODE" = "200" ] || { echo "API ROUTE FAIL: /api/apps => $LIST_CODE"; rm -f "$JAR"; exit 1; }
echo "api route OK: /api/apps 200"
rm -f "$JAR"

echo "== after =="
A1=$(probe_static)
echo "static-after: $A1"

# 本地重建确定性：删除 dist-accept 后两次独立构建，实测哈希比对（非单次读取）
DESIGNER_DIR="$ROOT/schema-frontend/apps/designer"
build_accept() {
  (cd "$ROOT/schema-frontend" && ACCEPT_BASE=1 pnpm --filter designer build > /dev/null)
}
echo "== rebuild determinism: build #1 =="
rm -rf "$DESIGNER_DIR/dist-accept"; build_accept
L1=$(sha256sum "$DESIGNER_DIR/dist-accept/index.html" | cut -d' ' -f1)
echo "build1: $L1"
echo "== rebuild determinism: build #2 (fresh) =="
rm -rf "$DESIGNER_DIR/dist-accept"; build_accept
L2=$(sha256sum "$DESIGNER_DIR/dist-accept/index.html" | cut -d' ' -f1)
echo "build2: $L2"
[ "$L1" = "$L2" ] || { echo "REBUILD NON-DETERMINISTIC: $L1 != $L2"; exit 1; }

cat > "$OUT/stability.json" <<EOF
{
  "sourceCommit": "$SHA",
  "sampledAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "method": "auto-probe",
  "checks": [
    {
      "name": "static-response-stable",
      "before": "$B1",
      "after": "$A1",
      "stable": $([ "$B1" = "$A1" ] && echo true || echo false)
    },
    {
      "name": "api-route-reachable",
      "csrfProbe": "$C1",
      "authenticatedAppsList": "$LIST_CODE"
    },
    {
      "name": "local-dist-rebuild-deterministic",
      "method": "two-fresh-builds",
      "build1": "$L1",
      "build2": "$L2",
      "deterministic": $([ "$L1" = "$L2" ] && echo true || echo false)
    }
  ]
}
EOF
echo "stability.json written"
[ "$B1" = "$A1" ] || { echo "STATIC UNSTABLE"; exit 1; }
