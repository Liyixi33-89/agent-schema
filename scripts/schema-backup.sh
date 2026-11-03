#!/usr/bin/env bash
# 每日备份：PostgreSQL schema_prod + 上传文件目录（03:30 cron 调用，migrate-to-releases.sh 注册）。
# 策略：DB 全量 pg_dump.gz + 文件目录 tar.gz；保留 14 天；备份失败写 ERROR 日志行（cron 日志可告警接入）。
set -uo pipefail
ROOT=/opt/schema
BACKUPS=$ROOT/backups
KEEP_DAYS=14
STAMP=$(date '+%Y%m%d-%H%M%S')

mkdir -p "$BACKUPS"
log() { echo "[$(date '+%F %T')] $*"; }

log "开始备份"
fail=0

# 1) 数据库
db_out="$BACKUPS/db-$STAMP.sql.gz"
if runuser -u postgres -- pg_dump schema_prod | gzip > "$db_out" 2>"$BACKUPS/db-$STAMP.err"; then
    rm -f "$BACKUPS/db-$STAMP.err"
    log "DB 备份完成: $(du -h "$db_out" | cut -f1) $db_out"
else
    log "ERROR: DB 备份失败（详见 $BACKUPS/db-$STAMP.err）"
    fail=1
fi

# 2) 上传文件
files_out="$BACKUPS/files-$STAMP.tar.gz"
if tar -czf "$files_out" -C "$ROOT/data" files 2>"$BACKUPS/files-$STAMP.err"; then
    rm -f "$BACKUPS/files-$STAMP.err"
    log "文件备份完成: $(du -h "$files_out" | cut -f1) $files_out"
else
    log "ERROR: 文件备份失败（详见 $BACKUPS/files-$STAMP.err）"
    fail=1
fi

# 3) 清理过期备份
find "$BACKUPS" -name 'db-*.sql.gz' -mtime +$KEEP_DAYS -delete
find "$BACKUPS" -name 'files-*.tar.gz' -mtime +$KEEP_DAYS -delete
find "$BACKUPS" -name 'pre-release-*.sql.gz' -mtime +$KEEP_DAYS -delete
find "$BACKUPS" -name '*.err' -mtime +$KEEP_DAYS -delete
log "过期备份已清理（保留 ${KEEP_DAYS} 天）"

# 4) 校验最新备份可解压（恢复演练的最小形态——每日自动验证备份非空且可读）
if [ -f "$db_out" ]; then
    if ! gzip -t "$db_out" 2>/dev/null; then
        log "ERROR: 最新 DB 备份 gzip 校验失败: $db_out"
        fail=1
    else
        head_bytes=$(zcat "$db_out" | head -c 100 | wc -c)
        [ "$head_bytes" -gt 0 ] || { log "ERROR: DB 备份内容为空"; fail=1; }
    fi
fi

[ $fail -eq 0 ] && log "备份全部成功" || log "备份存在失败项——请检查"
exit $fail
