# M13 验收面受控部署（designer 静态）——完整可执行版
# 形态：Windows PowerShell 主入口（WSL 内 ssh 连服务器不通——实测 exit 1，隧道与部署由 Windows 侧持有）
# 铁律：上传前后哈希核对；旧版本备份；原子替换；部署后探活；部署面哈希复核；全程无手填哈希。
# 用法（项目根 PowerShell）：
#   bash scripts/acceptance/deploy-accept-static.sh <runId>
#   等价分步（本脚本自动串行执行）：
#     1) 本地受控构建：ACCEPT_BASE=1 pnpm --filter designer build  （产物 dist-accept/）
#     2) 本地哈希实测（构建产物 index.html）
#     3) scp 上传到服务器临时目录
#     4) 服务器端：哈希核对（防传输损坏）→ 备份旧版 → 原子替换 → 探活 200 → 部署面哈希实测
#     5) 三面一致断言：本地哈希 == 上传哈希 == 部署面响应哈希
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
RUN_ID=${1:?用法: deploy-accept-static.sh <runId>}
HOST=111.231.57.177
USER=root
KEY=/mnt/c/Users/v_liyixili/.ssh/id_rsa
REMOTE_TMP=/tmp/accept-deploy-$RUN_ID
WEBROOT=/var/www/accept/designer
LOCAL_DIST="$ROOT/schema-frontend/apps/designer/dist-accept"

SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new $USER@$HOST"
SCP="scp -i $KEY -o StrictHostKeyChecking=accept-new"

fail() { echo "DEPLOY FAIL: $1" >&2; exit 1; }

# 1) 受控构建（验收面 base=/accept/designer/，独立 outDir）
cd "$ROOT/schema-frontend"
ACCEPT_BASE=1 pnpm --filter designer build > /dev/null
[ -f "$LOCAL_DIST/index.html" ] || fail "构建产物缺失"
cd "$ROOT"

# 2) 本地哈希实测
LOCAL_SHA=$(sha256sum "$LOCAL_DIST/index.html" | cut -d' ' -f1)
echo "local dist-accept sha256: $LOCAL_SHA"

# 3) 上传（打包传压缩包，服务器端解包——避免 scp -r 逐文件时序）
tar -C "$LOCAL_DIST" -czf /tmp/accept-dist-$RUN_ID.tgz .
$SSH "rm -rf $REMOTE_TMP && mkdir -p $REMOTE_TMP"
$SCP /tmp/accept-dist-$RUN_ID.tgz "$USER@$HOST:$REMOTE_TMP/"

# 4) 服务器端原子替换（哈希核对 → 备份 → 替换 → 探活 → 部署面哈希）
REMOTE_OUT=$($SSH "bash -s" <<EOS
set -euo pipefail
REMOTE_TMP=$REMOTE_TMP
WEBROOT=$WEBROOT
LOCAL_SHA=$LOCAL_SHA
cd "\$REMOTE_TMP"
tar -xzf accept-dist-*.tgz
UP_SHA=$(sha256sum index.html | cut -d' ' -f1)
[ "$UP_SHA" = "$LOCAL_SHA" ] || { echo "upload-corrupt:$UP_SHA"; exit 1; }
sudo mkdir -p "$WEBROOT"
if [ -d "$WEBROOT" ]; then
  BK="/var/www/accept/backup/designer-$(date -u +%Y%m%dT%H%M%SZ)"
  sudo mkdir -p "$(dirname "$BK")"
  sudo cp -r "$WEBROOT" "$BK"
fi
sudo rm -rf "${WEBROOT}.new"
sudo mkdir -p "${WEBROOT}.new"
sudo cp -r "$REMOTE_TMP"/. "${WEBROOT}.new/"
sudo rm -rf "$WEBROOT"
sudo mv "${WEBROOT}.new" "$WEBROOT"
sleep 1
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/accept/designer/)
[ "$CODE" = "200" ] || { echo "probe-fail:$CODE"; exit 1; }
DEPLOY_SHA=$(curl -s http://127.0.0.1/accept/designer/ | sha256sum | cut -d' ' -f1)
echo "OK deployed_sha=$DEPLOY_SHA backup=$BK"
EOS
)
echo "$REMOTE_OUT" | head -5
echo "$REMOTE_OUT" | grep -q "^OK deployed_sha=" || fail "服务器端部署失败: $REMOTE_OUT"

# 5) 三面一致断言（部署面响应体实测 vs 本地/上传实测）
DEPLOY_SHA=$(echo "$REMOTE_OUT" | sed -n 's/^OK deployed_sha=\([0-9a-f]*\).*/\1/p')
[ "$DEPLOY_SHA" = "$LOCAL_SHA" ] || fail "三面不一致 local=$LOCAL_SHA deploy=$DEPLOY_SHA"
rm -f /tmp/accept-dist-$RUN_ID.tgz

OUT="$ROOT/scripts/acceptance/out/$RUN_ID"
mkdir -p "$OUT"
cat > "$OUT/deployment.json" <<EOF
{
  "method": "deploy-accept-static.sh",
  "sourceCommit": "$(git -C "$ROOT" rev-parse HEAD)",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "artifact": "dist-accept (ACCEPT_BASE=1 build)",
  "localSha": "$LOCAL_SHA",
  "deployedSha": "$DEPLOY_SHA",
  "threeWayMatch": true,
  "backupPath": "$(echo "$REMOTE_OUT" | sed -n 's/.*backup=\(.*\)$/\1/p')"
}
EOF
echo "== DEPLOY DONE three-way sha match: $DEPLOY_SHA =="
