#!/usr/bin/env bash
# 每日备份 v2：PostgreSQL + 文件目录；权限收紧；失败告警；每日自动恢复演练。
# 由 migrate-to-releases.sh / setup 脚本注册 cron（03:30）。
# 告警：SCHEMA_ALERT_WEBHOOK 环境变量（/etc/schema-release.env 同级或本文件内 export），
#       失败时 POST 一行 JSON——未配置则仅日志（接入告警是上线门禁项，见 M16）。
set -uo pipefail
ROOT=/opt/schema
BACKUPS=$ROOT/backups
KEEP_DAYS=14
STAMP=$(date '+%Y%m%d-%H%M%S')
FAILURES=0

mkdir -p "$BACKUPS"
chmod 700 "$BACKUPS" 2>/dev/null || true
log() { echo "[$(date '+%F %T')] $*"; }
alert() { # 备份/恢复失败告警——webhook 未配置时仅日志
    log "ALERT: $*"
    local hook="${SCHEMA_ALERT_WEBHOOK:-$(grep -h '^SCHEMA_ALERT_WEBHOOK=' /etc/schema-platform.env /etc/schema-release.env 2>/dev/null | tail -1 | cut -d= -f2)}"
    [ -n "${hook:-}" ] && curl -sf -m 10 -X POST -H 'Content-Type: application/json' \
        -d "{\"text\":\"[schema-backup] $1 @ $(hostname) $(date -Is)\"}" "$hook" || true
}

log "开始备份"

# 1) 数据库（一致性问题说明：pg_dump 是库级 MVCC 快照——与文件备份的时间窗差异由
#    文件服务“上传先落盘后写记录”顺序保证附件引用完整性，极端窗口见恢复演练核对）
db_out="$BACKUPS/db-$STAMP.sql.gz"
if runuser -u postgres -- pg_dump schema_prod | gzip > "$db_out" 2>"$BACKUPS/db-$STAMP.err"; then
    rm -f "$BACKUPS/db-$STAMP.err"; chmod 600 "$db_out"
    log "DB 备份完成: $(du -h "$db_out" | cut -f1)"
else
    log "ERROR: DB 备份失败"; alert "DB 备份失败（详见 $BACKUPS/db-$STAMP.err）"
    FAILURES=$((FAILURES+1))
fi

# 2) 上传文件
files_out="$BACKUPS/files-$STAMP.tar.gz"
if tar -czf "$files_out" -C "$ROOT/data" files 2>"$BACKUPS/files-$STAMP.err"; then
    rm -f "$BACKUPS/files-$STAMP.err"; chmod 600 "$files_out"
    log "文件备份完成: $(du -h "$files_out" | cut -f1)"
else
    log "ERROR: 文件备份失败"; alert "文件备份失败（详见 $BACKUPS/files-$STAMP.err）"
    FAILURES=$((FAILURES+1))
fi

# 3) 过期清理（14 天）
find "$BACKUPS" \( -name 'db-*.sql.gz' -o -name 'files-*.tar.gz' \
    -o -name 'pre-release-*.sql.gz' -o -name '*.err' \) -mtime +$KEEP_DAYS -delete

# 4) 每日自动恢复演练：最新 DB 备份恢复到独立库并核对业务数据行数
if [ -f "$db_out" ] && [ -s "$db_out" ]; then
    if bash /opt/schema/restore-verify.sh "$db_out" "$files_out"; then
        log "恢复演练通过"
    else
        log "ERROR: 恢复演练失败"; alert "恢复演练失败——备份可能不可用！"
        FAILURES=$((FAILURES+1))
    fi
fi

[ $FAILURES -eq 0 ] && log "备份全部成功" || log "备份存在 $FAILURES 个失败项"
exit $FAILURES
