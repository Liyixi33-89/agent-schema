#!/usr/bin/env bash
# 一次性迁移：把「平铺部署」升级为「版本目录 + current 软链」（幂等，可重复执行）。
# 变更点：
#   1. 现有产物 /opt/schema/{schema-platform.jar, web} -> /opt/schema/releases/legacy-<date>/；
#   2. 建立 /opt/schema/current -> releases/<legacy>；systemd ExecStart 与 nginx root 改走 current；
#   3. systemd unit 注入版本环境（APP_VERSION/GIT_COMMIT 由发布脚本 EnvironmentFile 追加）；
#   4. nginx 443 server 块预留注释标识（HTTPS 待域名，用户决策 2026-11-03 暂缓）；
#   5. 安装 schema-release.sh 与备份脚本、每日备份 cron。
set -euo pipefail
ROOT=/opt/schema
SERVICE=schema-platform

log() { echo "[$(date '+%F %T')] $*"; }
[ "$(id -u)" = 0 ] || { echo "must run as root"; exit 1; }

# 1) 归档现有产物为 legacy 版本（已是软链结构则跳过）
if [ ! -L "$ROOT/current" ]; then
    V="legacy-$(date '+%Y%m%d')"
    [ -e "$ROOT/releases/$V" ] && V="$V-$(date '+%H%M%S')"
    mkdir -p "$ROOT/releases/$V"
    [ -f "$ROOT/schema-platform.jar" ] && mv "$ROOT/schema-platform.jar" "$ROOT/releases/$V/"
    [ -d "$ROOT/web" ] && mv "$ROOT/web" "$ROOT/releases/$V/web"
    ln -sfn "$ROOT/releases/$V" "$ROOT/current"
    printf '{"current":"%s","previous":"","switchedAt":"%s"}\n' "$V" "$(date -Is)" > "$ROOT/release-state.json"
    log "归档现有产物 -> releases/$V"
else
    log "current 软链已存在，跳过归档"
fi

# 2) systemd：ExecStart 走 current；新增 EnvironmentFile 追加版本注入
UNIT=/etc/systemd/system/$SERVICE.service
sed -i 's|-jar /opt/schema/schema-platform.jar|-jar /opt/schema/current/schema-platform.jar|' "$UNIT"
if ! grep -q 'schema-release.env' "$UNIT"; then
    sed -i '/^\[Service\]/a EnvironmentFile=-/etc/schema-release.env' "$UNIT"
fi
touch /etc/schema-release.env && chmod 600 /etc/schema-release.env
systemctl daemon-reload

# 3) nginx：root 指向 current/web；443 预留标识；探针不做特殊暴露（/internal/** 走默认反代）
NGINX=/etc/nginx/conf.d/schema.conf
if [ -f "$NGINX" ]; then
    sed -i 's|root /opt/schema/web;|root /opt/schema/current/web;|' "$NGINX"
    if ! grep -q 'HTTPS-RESERVED' "$NGINX"; then
        sed -i '/listen 80;/i # HTTPS-RESERVED (2026-11-03): 域名就绪后在此追加 443 server 块 + TLS 证书;\n# 同时给 /api/ 反代加 proxy_set_header X-Forwarded-Proto https, 后端启用 trusted-proxy 判定;\n# Secure Cookie 属性由后端按 X-Forwarded-Proto 自动收紧, 见 SessionCookies.' "$NGINX"
    fi
    nginx -t && systemctl reload nginx
fi

# 4) 安装发布与备份脚本
install -m 750 /dev/stdin "$ROOT/schema-release.sh" < /dev/null 2>/dev/null || true
log "请通过 deploy.py 上传 scripts/schema-release.sh（下一步）"

# 5) 每日备份 cron（DB + 文件）+ 保留 14 天
if ! crontab -l 2>/dev/null | grep -q schema-backup; then
    (crontab -l 2>/dev/null; echo '30 3 * * * /opt/schema/schema-backup.sh >> /var/log/schema-backup.log 2>&1') | crontab -
    log "已注册每日 03:30 备份 cron"
fi

systemctl restart $SERVICE
sleep 8
if curl -sf -m 5 http://127.0.0.1:18080/internal/health/readiness >/dev/null 2>&1; then
    log "服务就绪（旧版本探针可能无 /internal 路径——404 属预期，新版本发布后生效）"
else
    log "探针未就绪（legacy 版本无探针端点属预期）；回退检查:"
    curl -s -o /dev/null -w 'backend-root=%{http_code}\n' http://127.0.0.1:18080/ || true
fi
curl -s -o /dev/null -w 'nginx=%{http_code}\n' http://127.0.0.1/
log "迁移完成: current -> $(readlink $ROOT/current)"
