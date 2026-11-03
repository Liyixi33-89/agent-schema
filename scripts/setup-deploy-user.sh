#!/usr/bin/env bash
# 一次性：创建 deploy 专用部署账号 + sudo 白名单（日常发布不再用 root SSH）。
# 白名单只放 schema-release.sh / schema-backup.sh / restore-verify.sh 三支脚本——
# deploy 用户拿不到其它 root 权限；脚本本体 root 属主 750，deploy 不可篡改。
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "must run as root"; exit 1; }

id deploy >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash deploy

# sudo 白名单：NOPASSWD 仅限三支发布脚本（参数不限——脚本内部自有闸门：锁/manifest/迁移边界）
cat > /etc/sudoers.d/schema-deploy <<'EOF'
deploy ALL=(root) NOPASSWD: /bin/bash /opt/schema/schema-release.sh *
deploy ALL=(root) NOPASSWD: /bin/bash /opt/schema/schema-backup.sh
deploy ALL=(root) NOPASSWD: /bin/bash /opt/schema/restore-verify.sh
EOF
chmod 440 /etc/sudoers.d/schema-deploy
visudo -c

# 脚本属主 root、750（deploy 经 sudo 执行，不可写脚本本体）
chown root:root /opt/schema/schema-release.sh /opt/schema/schema-backup.sh /opt/schema/restore-verify.sh 2>/dev/null || true
chmod 750 /opt/schema/schema-release.sh /opt/schema/schema-backup.sh /opt/schema/restore-verify.sh 2>/dev/null || true

mkdir -p /home/deploy/.ssh && chmod 700 /home/deploy/.ssh
echo "deploy 账号就绪。"
echo "下一步: 把部署公钥追加到 /home/deploy/.ssh/authorized_keys（chmod 600, chown deploy:deploy）"
echo "验证: ssh deploy@<host> 'sudo -n bash /opt/schema/schema-release.sh status'"
