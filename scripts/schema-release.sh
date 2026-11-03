#!/usr/bin/env bash
# Schema 平台发布脚本（服务器侧执行）——M16 发布体系最小集
#
# 用法：
#   schema-release.sh upload    <version>          # 从 stdin 收 tar 流，展开到 releases/<version>/
#   schema-release.sh switch    <version>          # 切 current 软链 → 重启后端 → 就绪探针 → 失败自动回滚
#   schema-release.sh rollback  [version]          # 回滚（缺省 = current 所指的上一版本记录）
#   schema-release.sh status                       # 当前版本/历史/探针状态
#
# 目录布局（用户定版 2026-11-03）：
#   /opt/schema/releases/<version>/{schema-platform.jar, web/..., VERSION.txt}
#   /opt/schema/current -> releases/<version>      # systemd 与 nginx 一律经 current 访问
#   /opt/schema/data/                              # 持久化（PG 数据在系统目录，文件在 data/files）
#   /opt/schema/release-state.json                 # 当前/上一版本记录（回滚依据，机器可读）
#
# 边界：
# - 数据库迁移由 Flyway 随应用启动执行；本脚本不做反向迁移，回滚仅回退应用版本；
#   迁移向后兼容由「DDL 铁律：永不 DROP COLUMN、只增不改」保证（旧代码容忍新增列的默认值）；
# - 就绪探针：GET http://127.0.0.1:18080/internal/health/readiness（DeploymentProbeFilter 提供）；
# - 失败自动回滚：switch 后探针 120s 内不 UP 即恢复上一版本并二次验证；
# - 发布前自动执行一次数据库备份（pg_dump 到 backups/，失败则中止发布）。
set -euo pipefail

ROOT=/opt/schema
RELEASES=$ROOT/releases
CURRENT=$ROOT/current
STATE=$ROOT/release-state.json
BACKUPS=$ROOT/backups
SERVICE=schema-platform
HEALTH_URL=http://127.0.0.1:18080/internal/health/readiness
WAIT_TIMEOUT=120

log() { echo "[$(date '+%F %T')] $*"; }

die() { log "ERROR: $*"; exit 1; }

require_root() { [ "$(id -u)" = 0 ] || die "must run as root"; }

read_state() { # key -> value
    [ -f "$STATE" ] || return 1
    python3 -c "import json,sys;d=json.load(open('$STATE'));print(d.get(sys.argv[1],''))" "$1"
}

write_state() { # current previous
    mkdir -p "$RELEASES"
    printf '{"current":"%s","previous":"%s","switchedAt":"%s"}\n' \
        "$1" "$2" "$(date -Is)" > "$STATE"
}

wait_ready() {
    local deadline=$((SECONDS + WAIT_TIMEOUT))
    while [ $SECONDS -lt $deadline ]; do
        if curl -sf -m 5 "$HEALTH_URL" >/dev/null 2>&1; then
            return 0
        fi
        sleep 3
    done
    return 1
}

probe_now() {
    curl -sf -m 5 "$HEALTH_URL" 2>/dev/null || echo '{"status":"UNREACHABLE"}'
}

backup_db() {
    mkdir -p "$BACKUPS"
    local out="$BACKUPS/pre-release-$(date '+%Y%m%d-%H%M%S').sql.gz"
    log "备份数据库 -> $out"
    if ! runuser -u postgres -- pg_dump schema_prod | gzip > "$out"; then
        rm -f "$out"
        die "数据库备份失败——发布中止"
    fi
    log "备份完成 $(du -h "$out" | cut -f1)"
    # 保留策略：最多 14 份发布前备份
    ls -1t "$BACKUPS"/pre-release-*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm -f --
}

cmd_upload() {
    local version="${1:?version required}"
    require_root
    local dest="$RELEASES/$version"
    [ -e "$dest" ] && die "版本已存在: $dest（版本不可覆盖——请用新版本号）"
    mkdir -p "$dest"
    log "接收产物流 -> $dest"
    tar -xzf - -C "$dest"
    [ -f "$dest/schema-platform.jar" ] || { rm -rf "$dest"; die "产物缺 schema-platform.jar"; }
    [ -d "$dest/web" ] || { rm -rf "$dest"; die "产物缺 web/"; }
    chown -R schema:schema "$dest"
    # 权限模型：jar 收紧（640）；web/** 与版本目录必须全局可读——nginx worker 以 nginx
    # 用户运行，目录不可穿越即全站 403（2026-11-03 演练实测：750 版本目录挡住 nginx）。
    chmod 755 "$dest"
    chmod 640 "$dest/schema-platform.jar"
    find "$dest/web" -type d -exec chmod 755 {} +
    find "$dest/web" -type f -exec chmod 644 {} +
    log "上传完成: $version ($(du -sh "$dest" | cut -f1))"
}

switch_to() { # version（不做回滚保护——内部复用）
    local version="$1"
    # 版本注入：systemd EnvironmentFile（migrate-to-releases.sh 已挂 /etc/schema-release.env）——
    # DeploymentProbeFilter 读 APP_VERSION/GIT_COMMIT，线上可回答「跑的是哪个 commit」。
    printf 'APP_VERSION=%s\nGIT_COMMIT=%s\n' "$version" "$version" > /etc/schema-release.env
    chmod 600 /etc/schema-release.env
    ln -sfn "$RELEASES/$version" "$CURRENT"
    systemctl restart "$SERVICE"
    if ! wait_ready; then
        log "就绪探针失败，当前探针输出: $(probe_now)"
        return 1
    fi
    log "版本 $version 就绪: $(probe_now)"
}

cmd_switch() {
    local version="${1:?version required}"
    require_root
    [ -d "$RELEASES/$version" ] || die "版本不存在: $RELEASES/$version"
    local prev; prev=$(read_state current || true)
    backup_db
    log "切换版本 ${prev:-<首次>} -> $version"
    if switch_to "$version"; then
        write_state "$version" "${prev:-}"
        log "发布成功: $version"
    else
        log "发布失败——自动回滚到 ${prev:-无（首版无回滚目标）}"
        if [ -n "$prev" ] && [ -d "$RELEASES/$prev" ]; then
            switch_to "$prev" || die "回滚后探针仍失败——人工介入: journalctl -u $SERVICE"
            log "已回滚到 $prev"
        else
            die "无可用上一版本——人工介入: journalctl -u $SERVICE"
        fi
        exit 1
    fi
}

cmd_rollback() {
    require_root
    local target="${1:-}"
    [ -z "$target" ] && target=$(read_state previous || true)
    [ -n "$target" ] || die "未指定回滚版本且状态文件无上一版本记录"
    [ -d "$RELEASES/$target" ] || die "回滚版本不存在: $target"
    local cur; cur=$(read_state current || echo "")
    log "回滚 ${cur:-?} -> $target"
    if switch_to "$target"; then
        write_state "$target" "${cur:-}"
        log "回滚成功: $target"
    else
        die "回滚后探针失败——人工介入"
    fi
}

cmd_status() {
    echo "== current -> $(readlink "$CURRENT" 2>/dev/null || echo '<无>')"
    [ -f "$STATE" ] && cat "$STATE"
    echo "== releases:"
    ls -1t "$RELEASES" 2>/dev/null || echo "(无)"
    echo "== probe: $(probe_now)"
    echo "== disk: $(df -h "$ROOT" | tail -1)"
}

case "${1:-}" in
    upload)   shift; cmd_upload "$@" ;;
    switch)   shift; cmd_switch "$@" ;;
    rollback) shift; cmd_rollback "$@" ;;
    status)   cmd_status ;;
    *) sed -n '2,12p' "$0"; exit 2 ;;
esac
