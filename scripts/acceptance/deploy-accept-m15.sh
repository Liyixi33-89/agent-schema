# M15 公网验收面受控部署（designer + runtime 双面）
# 形态：Windows PowerShell 主入口调 WSL bash（ssh/scp 从 WSL 侧连服务器）
# 铁律：上传前后哈希核对；旧版本备份；原子替换；部署后探活；部署面哈希复核；全程无手填哈希。
# 与 M13 版差异：
#  - 双面部署（designer + runtime），runtime 构建注入 VITE_API_BASE=/accept（artifactUrl 修复路由）
#  - 备份入 /opt/schema/staging/accept/backup/<ts>/（服务器统一备份区，含两面前快照与 manifest）
# 用法（项目根 PowerShell）：bash scripts/acceptance/deploy-accept-m15.sh <runId>
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
RUN_ID=${1:?用法: deploy-accept-m15.sh <runId>}
HOST=111.231.57.177
USER=root
# 密钥解析：WSL 下优先 ~/.ssh/id_rsa（/mnt/c 挂载权限 0777 会被 ssh 拒绝）；Windows 侧回退原始路径
if [ -f "$HOME/.ssh/id_rsa" ] && [ -n "${WSL_DISTRO_NAME:-}" ]; then
  KEY="$HOME/.ssh/id_rsa"
else
  KEY=/mnt/c/Users/v_liyixili/.ssh/id_rsa
fi
REMOTE_TMP=/tmp/accept-deploy-$RUN_ID
ACCEPT_ROOT=/opt/schema/staging/accept
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new $USER@$HOST"
SCP="scp -i $KEY -o StrictHostKeyChecking=accept-new"

fail() { echo "DEPLOY FAIL: $1" >&2; exit 1; }

# 1) 受控构建（验收面 base 前缀 + API 前缀注入）
#    SKIP_BUILD=1 时跳过（构建已在 Windows 侧完成——WSL 无 node 环境，见下方说明）
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  cd "$ROOT/schema-frontend"
  # ⚠️ designer 与 runtime 均须注入 VITE_API_BASE=/accept——请求层 baseUrl 真源；
  #    漏注入则页面 API 请求走根 /api（404，登录页不出现——2026-11-12 公网轮实测教训）
  ACCEPT_BASE=1 VITE_API_BASE=/accept pnpm --filter designer build > /dev/null
  ACCEPT_BASE=1 VITE_API_BASE=/accept pnpm --filter runtime build > /dev/null
fi
DESIGNER_DIST="$ROOT/schema-frontend/apps/designer/dist-accept"
RUNTIME_DIST="$ROOT/schema-frontend/apps/runtime/dist-accept"
[ -f "$DESIGNER_DIST/index.html" ] || fail "designer 构建产物缺失"
[ -f "$RUNTIME_DIST/index.html" ] || fail "runtime 构建产物缺失"
cd "$ROOT"

# 2) 本地哈希实测（index.html 两面）
D_SHA=$(sha256sum "$DESIGNER_DIST/index.html" | cut -d' ' -f1)
R_SHA=$(sha256sum "$RUNTIME_DIST/index.html" | cut -d' ' -f1)
echo "designer sha256: $D_SHA"
echo "runtime sha256: $R_SHA"

# 3) 上传（两面各自打包）
tar -C "$DESIGNER_DIST" -czf /tmp/accept-d-$RUN_ID.tgz .
tar -C "$RUNTIME_DIST" -czf /tmp/accept-r-$RUN_ID.tgz .
$SSH "rm -rf $REMOTE_TMP && mkdir -p $REMOTE_TMP"
$SCP /tmp/accept-d-$RUN_ID.tgz "$USER@$HOST:$REMOTE_TMP/designer.tgz"
$SCP /tmp/accept-r-$RUN_ID.tgz "$USER@$HOST:$REMOTE_TMP/runtime.tgz"

# 4) 服务器端：哈希核对 → 备份 → 原子替换 → 探活 → 部署面哈希
REMOTE_OUT=$($SSH "bash -s" <<EOS
set -euo pipefail
REMOTE_TMP=$REMOTE_TMP
ACCEPT_ROOT=$ACCEPT_ROOT
D_SHA=$D_SHA
R_SHA=$R_SHA
cd "\$REMOTE_TMP"
mkdir -p designer runtime
tar -xzf designer.tgz -C designer
tar -xzf runtime.tgz -C runtime
[ "\$(sha256sum designer/index.html | cut -d' ' -f1)" = "\$D_SHA" ] || { echo "upload-corrupt:designer"; exit 1; }
[ "\$(sha256sum runtime/index.html | cut -d' ' -f1)" = "\$R_SHA" ] || { echo "upload-corrupt:runtime"; exit 1; }
# 备份两面前快照到统一备份区
BK="\$ACCEPT_ROOT/backup/\$(date -u +%Y%m%dT%H%M%SZ)-$RUN_ID"
mkdir -p "\$BK"
cp -r "\$ACCEPT_ROOT/designer" "\$BK/designer" 2>/dev/null || true
cp -r "\$ACCEPT_ROOT/runtime" "\$BK/runtime" 2>/dev/null || true
echo "\$(date -u +%Y-%m-%dT%H:%M:%SZ) m15-accept-deploy $RUN_ID" > "\$BK/manifest.txt"
sha256sum "\$ACCEPT_ROOT/designer/index.html" "\$ACCEPT_ROOT/runtime/index.html" >> "\$BK/manifest.txt" 2>/dev/null || true
# 原子替换（.new 交换）
for app in designer runtime; do
  rm -rf "\$ACCEPT_ROOT/\$app.new"
  mkdir -p "\$ACCEPT_ROOT/\$app.new"
  cp -r "\$REMOTE_TMP/\$app/." "\$ACCEPT_ROOT/\$app.new/"
  rm -rf "\$ACCEPT_ROOT/\$app"
  mv "\$ACCEPT_ROOT/\$app.new" "\$ACCEPT_ROOT/\$app"
done
sleep 1
for app in designer runtime; do
  CODE=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/accept/\$app/)
  [ "\$CODE" = "200" ] || { echo "probe-fail:\$app:\$CODE"; exit 1; }
done
D_DEPLOY=\$(curl -s http://127.0.0.1/accept/designer/ | sha256sum | cut -d' ' -f1)
R_DEPLOY=\$(curl -s http://127.0.0.1/accept/runtime/ | sha256sum | cut -d' ' -f1)
echo "OK d_deployed=\$D_DEPLOY r_deployed=\$R_DEPLOY backup=\$BK"
EOS
)
echo "$REMOTE_OUT" | tail -3
echo "$REMOTE_OUT" | grep -q "^OK " || fail "服务器端部署失败: $REMOTE_OUT"

# 5) 三面一致断言
D_DEPLOY=$(echo "$REMOTE_OUT" | sed -n 's/^OK d_deployed=\([0-9a-f]*\).*/\1/p')
R_DEPLOY=$(echo "$REMOTE_OUT" | sed -n 's/.*r_deployed=\([0-9a-f]*\).*/\1/p')
[ "$D_DEPLOY" = "$D_SHA" ] || fail "designer 三面不一致 local=$D_SHA deploy=$D_DEPLOY"
[ "$R_DEPLOY" = "$R_SHA" ] || fail "runtime 三面不一致 local=$R_SHA deploy=$R_DEPLOY"
rm -f /tmp/accept-d-$RUN_ID.tgz /tmp/accept-r-$RUN_ID.tgz

OUT="$ROOT/scripts/acceptance/out/$RUN_ID"
mkdir -p "$OUT"
cat > "$OUT/deployment.json" <<EOF
{
  "method": "deploy-accept-m15.sh",
  "sourceCommit": "$(git -C "$ROOT" rev-parse HEAD)",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "designer": { "artifact": "dist-accept (ACCEPT_BASE=1)", "localSha": "$D_SHA", "deployedSha": "$D_DEPLOY" },
  "runtime": { "artifact": "dist-accept (ACCEPT_BASE=1 VITE_API_BASE=/accept)", "localSha": "$R_SHA", "deployedSha": "$R_DEPLOY" },
  "threeWayMatch": true,
  "backupPath": "$(echo "$REMOTE_OUT" | sed -n 's/.*backup=\(.*\)$/\1/p')"
}
EOF
echo "== DEPLOY DONE three-way match: designer=$D_SHA runtime=$R_SHA =="
