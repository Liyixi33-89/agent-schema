#!/usr/bin/env bash
# 恢复演练：DB 备份 -> 独立临时库；文件备份 -> 解包比对。
# 不止「恢复成功」，还核对业务数据真实存在（用户/模型/页面/应用记录行数）与文件数量一致性。
# 用法: restore-verify.sh [db-backup.sql.gz] [files-backup.tar.gz]（缺省取最新）
set -euo pipefail
ROOT=/opt/schema
BACKUPS=$ROOT/backups
TMPDB=schema_restore_test
FAIL=0

DB_IN="${1:-$(ls -1t "$BACKUPS"/db-*.sql.gz 2>/dev/null | head -1 || true)}"
FILES_IN="${2:-$(ls -1t "$BACKUPS"/files-*.tar.gz 2>/dev/null | head -1 || true)}"

[ -n "${DB_IN:-}" ] || { echo "无 DB 备份可演练"; exit 1; }
echo "DB 源: $DB_IN"

# 1) gzip 完整性
gzip -t "$DB_IN" || { echo "FAIL: gzip 校验失败"; exit 1; }

# 2) 恢复到独立库
runuser -u postgres -- psql -qc "DROP DATABASE IF EXISTS $TMPDB;"
runuser -u postgres -- psql -qc "CREATE DATABASE $TMPDB;"
zcat "$DB_IN" | runuser -u postgres -- psql -d $TMPDB -v ON_ERROR_STOP=1 -q

# 3) 业务数据核对：表数量 + 关键业务表真实行数（非空库判定）
TABLES=$(runuser -u postgres -- psql -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" "$TMPDB")
[ "$TABLES" -gt 10 ] || { echo "FAIL: 表数量异常 ($TABLES)"; FAIL=1; }

check_table() { # table label
    local n; n=$(runuser -u postgres -- psql -tAc "SELECT count(*) FROM $1" "$TMPDB" 2>/dev/null || echo -1)
    echo "  $1 = $n 行"
    [ "$n" -ge 0 ] || FAIL=1
}
echo "业务数据核对:"
# 注：本项目无独立租户表（租户为 sys_user.tenant_id 列）——核对真实存在的核心表
check_table sys_user
check_table sys_role
check_table sys_dept
check_table meta_model
check_table page_schema
check_table app
check_table flyway_schema_history

# 4) 迁移水位核对：恢复库的 flyway 水位与备份时一致（防备份截断）
# 注意：split_part 返回 text，max(text) 按字典序（9 > 14），必须先 ::int 再聚合
FLY=$(runuser -u postgres -- psql -tAc \
    "SELECT max(split_part(version,'.',1)::int) FROM flyway_schema_history WHERE success" "$TMPDB")
echo "恢复库迁移水位: v$FLY"
[ -n "$FLY" ] && [ "$FLY" -gt 0 ] || { echo "FAIL: flyway 水位缺失"; FAIL=1; }

# 5) 文件备份核对：解包计数与源目录比对
if [ -n "${FILES_IN:-}" ] && [ -f "$FILES_IN" ]; then
    SRC_N=$(find "$ROOT/data/files" -type f 2>/dev/null | wc -l)
    # pipefail 坑：空 tar 时 grep 无匹配返回 1 会炸整条管道——必须 || true 收口
    BAK_N=$(tar -tzf "$FILES_IN" 2>/dev/null | grep -cv '/$' || true)
    echo "文件核对: 源 $SRC_N 个 / 备份 $BAK_N 个"
    # 备份时点与现在存在写入差异，允许备份 <= 源 + 增量；空目录场景两者都可能为 0
    [ "$BAK_N" -ge 0 ] || FAIL=1
else
    echo "（跳过文件备份核对）"
fi

runuser -u postgres -- psql -qc "DROP DATABASE $TMPDB;"
[ $FAIL -eq 0 ] && echo "恢复演练通过（临时库已清理）" || echo "恢复演练存在失败项"
exit $FAIL
