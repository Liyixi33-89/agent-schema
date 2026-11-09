# M13 验收面受控部署（designer 静态）：本地受控构建 → 校验 → 上传 → 原子替换 → 探活
# 用法（本地 PowerShell）：bash 不适用——直接用 scp；此脚本在本地 Git Bash/WSL 或手动分步执行。
# 约束：上传前后哈希核对（防传输损坏）；旧版本备份；部署后探活 200。
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_rsa}
SRV=${SRV:-root@111.231.57.177}
REMOTE_DIR=/opt/schema/staging/accept/designer

echo "== 1. 校验本地产物与 HEAD 一致 =="
SHA=$(git -C "$ROOT" rev-parse HEAD)
echo "HEAD: $SHA"
HTML="$ROOT/schema-frontend/apps/designer/dist/index.html"
[ -f "$HTML" ] || { echo "缺 designer dist——先跑受控构建"; exit 1; }
LOCAL_SHA=$(sha256sum "$HTML" | cut -d' ' -f1)
echo "local index.html: $LOCAL_SHA"

echo "== 2. 上传到临时目录 =="
TMP_DIR=/tmp/accept-deploy-$$
ssh -i "$SSH_KEY" "$SRV" "mkdir -p $TMP_DIR"
scp -i "$SSH_KEY" -r "$ROOT/schema-frontend/apps/designer/dist/." "$SRV:$TMP_DIR/"

echo "== 3. 服务器端哈希核对 =="
REMOTE_SHA=$(ssh -i "$SSH_KEY" "$SRV" "sha256sum $TMP_DIR/index.html | cut -d' ' -f1")
[ "$LOCAL_SHA" = "$REMOTE_SHA" ] || { echo "传输哈希不符: local=$LOCAL_SHA remote=$REMOTE_SHA"; exit 1; }
echo "传输校验一致: $REMOTE_SHA"

echo "== 4. 原子替换（备份旧版本） =="
ssh -i "$SSH_KEY" "$SRV" "
  set -e
  [ -d $REMOTE_DIR ] && cp -r $REMOTE_DIR ${REMOTE_DIR}.bak.\$(date +%s) || true
  rm -rf $REMOTE_DIR
  mv $TMP_DIR $REMOTE_DIR
  chmod -R a+rX $REMOTE_DIR
"

echo "== 5. 探活 =="
sleep 1
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/accept/designer/ || echo FAIL)
[ "$CODE" = "200" ] || { echo "探活失败: $CODE"; exit 1; }
DEPLOYED_SHA=$(curl -s http://127.0.0.1/accept/designer/ | sha256sum | cut -d' ' -f1)
echo "deployed sha256: $DEPLOYED_SHA"
[ "$DEPLOYED_SHA" = "$LOCAL_SHA" ] || { echo "部署面哈希与本地不符"; exit 1; }
echo "部署完成: /accept/designer/ -> $SHA"
