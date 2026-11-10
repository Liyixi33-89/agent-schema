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
# 注意：公网面 nginx 对未带 Origin 的 GET /api/auth/csrf 返回 401（CsrfFilter 会话前置判定），
# cookie jar 里没有 schema_csrf——登录态探针改走「完整三件套」：先 GET 拿凭证（带 Origin 头）、
# 再登录、再列表；若公网面凭证下发仍不可用则如实降级记录（不吞错报成功）。
C1=$(curl -s -o /dev/null -w '%{http_code}' http://111.231.57.177/accept/api/auth/csrf)
[ "$C1" = "401" ] || [ "$C1" = "200" ] || { echo "API PROBE FAIL: $C1"; exit 1; }
echo "api probe OK: $C1"
# 公网面实测：GET /api/auth/csrf 返回 401 且不下发凭证（CsrfFilter 会话前置判定——
# 浏览器路径先经登录页初始化才下发）。curl 直连走不了该路径，登录态探针如实降级：
# 未认证访问受保护资源必须 401（路由存在且鉴权链生效——404 才是路由不可达）。
JAR=$(mktemp)
LIST_CODE=unprobed
curl -s -c "$JAR" -H "Origin: http://111.231.57.177" http://111.231.57.177/accept/api/auth/csrf -o /dev/null
# set -e + pipefail 下 grep 无匹配（退出码 1）会杀脚本——cookie jar 无该行是合法态，显式兜底
CSRF=$(grep schema_csrf "$JAR" 2>/dev/null | awk '{print $7}' || true)
if [ -n "$CSRF" ]; then
  curl -s -b "$JAR" -c "$JAR" -X POST http://111.231.57.177/accept/api/auth/login \
    -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF" \
    -H "Origin: http://111.231.57.177" \
    -d '{"username":"accept_admin","password":"Accept!2026"}' -o /dev/null
  LIST_CODE=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "http://111.231.57.177/accept/api/apps")
else
  echo "NOTE: csrf 凭证未下发（公网面 401 前置），登录态路由探针走降级路径"
fi
rm -f "$JAR"
if [ "$LIST_CODE" != "unprobed" ]; then
  [ "$LIST_CODE" = "200" ] || { echo "API ROUTE FAIL: /api/apps => $LIST_CODE"; exit 1; }
  echo "api route OK: /api/apps 200"
else
  UNAUTH=$(curl -s -o /dev/null -w '%{http_code}' "http://111.231.57.177/accept/api/apps")
  [ "$UNAUTH" = "401" ] || { echo "API ROUTE FAIL: unauth /api/apps => $UNAUTH (期望 401，非 404)"; exit 1; }
  echo "api route OK (degraded): unauth /api/apps => 401 (路由存在，鉴权生效)"
fi

echo "== after =="
A1=$(probe_static)
echo "static-after: $A1"

# 本地重建确定性：删除 dist-accept 后两次独立构建，实测哈希比对（非单次读取）
# WSL 内无 node/pnpm——构建经 Windows 侧 node.exe 执行（cmd /c 走 Windows PATH）；
# 若 Windows node 也不可用则显式失败（禁止跳过构建冒充确定性）
DESIGNER_DIR="$ROOT/schema-frontend/apps/designer"
NODE_EXE=$(command -v node || command -v node.exe || echo "")
if [ -z "$NODE_EXE" ] && [ -x /mnt/e/nodejs/node.exe ]; then NODE_EXE="/mnt/e/nodejs/node.exe"; fi
WIN_PNPM=""
for cand in "/mnt/e/nodejs/pnpm.cmd" "/mnt/e/nodejs/pnpm" "/mnt/c/Program Files/nodejs/pnpm.cmd"; do
  [ -f "$cand" ] && WIN_PNPM="$cand" && break
done
build_accept() {
  # Windows pnpm 为 .ps1（无 .cmd 垫片）——经 powershell.exe 执行并透传 ACCEPT_BASE。
  # 注意 WSL 里 powershell.exe 的 cwd 会跳到 Windows 侧等价目录，必须显式 -Command "cd <win路径>; ..."
  if [ -f /mnt/e/nodejs/pnpm.ps1 ]; then
    (cd "$ROOT/schema-frontend" && ACCEPT_BASE=1 powershell.exe -NoProfile -Command "cd C:\\Users\\v_liyixili\\Desktop\\2026\\schema\\schema-frontend; \$env:ACCEPT_BASE='1'; pnpm --filter designer build" > /dev/null 2>&1)
  elif [ -n "$WIN_PNPM" ]; then
    (cd "$ROOT/schema-frontend" && ACCEPT_BASE=1 cmd.exe /c "pnpm --filter designer build" > /dev/null 2>&1)
  else
    (cd "$ROOT/schema-frontend" && ACCEPT_BASE=1 pnpm --filter designer build > /dev/null)
  fi
}
{ command -v pnpm > /dev/null 2>&1 || [ -f /mnt/e/nodejs/pnpm.ps1 ] || [ -n "$WIN_PNPM" ]; } || { echo "REBUILD FAIL: WSL 内无 pnpm 且未定位 Windows pnpm"; exit 1; }
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
