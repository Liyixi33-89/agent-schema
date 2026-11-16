#!/usr/bin/env bash
# 每日备份 v3：修复 OpenCloudOS 无 runuser 导致备份链路自上线起全空（20 字节 gzip）。
# 变更（2026-11-16）：
#   - runuser -u postgres -- pg_dump  → su - postgres -c "pg_dump ..."（管道重定向由 root 侧完成）
#   - 恢复演练改为调 restore-verify.sh（同轮修复，见其头部说明）
# 其余口径不变：库级 MVCC 快照、文件先落盘后写记录、14 天保留、失败告警、每日自动恢复演练。
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
# 备份库清单：schema_prod（生产，当前业务空库）+ schema_acceptance（验收面，真实业务数据所在）。
# 演练教训（2026-11-16 DR-01）：只备份 schema_prod 会漏掉验收库全部 53 表业务数据。
for DB in schema_prod schema_acceptance; do
  db_out="$BACKUPS/db-${DB}-$STAMP.sql.gz"
  if su - postgres -c "pg_dump $DB" | gzip > "$db_out" 2>"$BACKUPS/db-${DB}-$STAMP.err"; then
    rm -f "$BACKUPS/db-${DB}-$STAMP.err"; chmod 600 "$db_out"
    log "DB 备份完成 ($DB): $(du -h "$db_out" | cut -f1)"
  else
    log "ERROR: DB 备份失败 ($DB)"; alert "DB 备份失败 $DB（详见 $BACKUPS/db-${DB}-$STAMP.err）"
    FAILURES=$((FAILURES+1))
  fi
done
db_out="$BACKUPS/db-schema_acceptance-$STAMP.sql.gz"   # 恢复演练用最新验收库备份

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
if [ -s "$db_out" ]; then
    if bash /opt/schema/restore-verify.sh "$db_out" "$files_out"; then
        log "恢复演练通过"
    else
        log "ERROR: 恢复演练失败"; alert "恢复演练失败——备份可能不可用！"
        FAILURES=$((FAILURES+1))
    fi
fi

[ $FAILURES -eq 0 ] && log "备份全部成功" || log "备份存在 $FAILURES 个失败项"
exit $FAILURES
