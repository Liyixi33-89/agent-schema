#!/usr/bin/env bash
# =============================================================================
# Flowable 启用前「只读探测」——不写任何数据，只报告现状
#
# 用途：在 IT 库启用 Flowable 前，确认环境状态与建表影响面。
# 安全：全部为 SELECT / 元数据查询，无 DDL、无 DML。
#
# 用法（在服务器上执行）：
#   bash flow-probe-readonly.sh <db_name> <db_user>
# 例：
#   bash flow-probe-readonly.sh schema_it schema_it
#
# 连接信息通过环境变量传入（不硬编码口令）：
#   PGHOST / PGPORT / PGPASSWORD
# =============================================================================
set -uo pipefail

DB_NAME="${1:-schema_it}"
DB_USER="${2:-$(whoami)}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
# 连接超时：缺省 psql 连不上会长时间挂住（实测本机无 PG 时卡死），
# 显式 10s 上限让失败快速可见
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"

# -w（--no-password）：没有 PGPASSWORD/PGPASSFILE 时**不要**交互式提示，
#    直接失败退出。否则在非交互环境（CI/脚本/子进程）会永久挂住在密码提示上
#    （本机实测：缺 PGPASSWORD 时卡死 20s+ 不返回，正是这条修复解决的）
PSQL="psql -w -h $PGHOST -p $PGPORT -U $DB_USER -d $DB_NAME -t -A -F'|'"

echo "============================================================"
echo " Flowable 启用前只读探测"
echo " 目标库: $DB_NAME @ $PGHOST:$PGPORT  用户: $DB_USER"
echo " 时间:   $(date -Iseconds)"
echo "============================================================"
echo

# 前置：缺 psql 直接给出可执行建议，不留一堆「command not found」
if ! command -v psql >/dev/null 2>&1; then
  echo "❌ 未找到 psql 客户端"
  echo "   Debian/Ubuntu: apt-get install -y postgresql-client"
  echo "   RHEL/CentOS:   yum install -y postgresql"
  exit 1
fi

# ---------- 0. 连通性与身份 ----------
echo "[0] 连通性 / 权限"
# 先单独验证连接：连不上就立即退出，避免后面每条查询各报一次错（噪音淹没真问题）
if ! $PSQL -c "SELECT 1;" >/dev/null 2>&1; then
  echo "❌ 无法连接 $DB_NAME @ $PGHOST:$PGPORT（用户 $DB_USER）"
  echo "   排查："
  echo "   1) 隧道是否建立？  例：ssh -L 15432:127.0.0.1:5432 root@<host>"
  echo "   2) 库名/用户是否正确？PGHOST/PGPORT/PGPASSWORD 环境变量是否设置？"
  echo "   3) 若走隧道端口，记得 PGPORT=<本地转发端口>"
  exit 1
fi
$PSQL -c "SELECT current_database(), current_user, version();" 2>&1 | sed 's/^/    /'
# 建表权限检查：正确判据是 schema 上的 CREATE 权限（数据库级 CREATE 只控制建 schema）
$PSQL -c "SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_table_in_public;" 2>&1 | sed 's/^/    /'
echo

# ---------- 1. 现有 ACT_* 表（是否已经装过 Flowable）----------
echo "[1] 现有 Flowable 表（ACT_* / FLW_*）"
COUNT=$($PSQL -c "
  SELECT count(*) FROM information_schema.tables
  WHERE table_schema = 'public' AND (table_name LIKE 'ACT\_%' OR table_name LIKE 'FLW\_%');
" 2>&1)
echo "    已有 Flowable 表数量: $COUNT"
if [ "${COUNT:-0}" != "0" ]; then
  echo "    ⚠️ 该库已存在 Flowable 表——请勿重复执行建表，先核对版本："
  # ⚠️ Flowable 列名带下划线后缀（NAME_ / VALUE_ / REV_）——按真实 DDL 写，
  #    写成 name/value_ 会直接报「列不存在」（已核对 flowable.postgres.create.common.sql）
  $PSQL -c "
    SELECT NAME_ || '=' || VALUE_ FROM act_ge_property
    WHERE NAME_ IN ('schema.version','schema.history') ORDER BY NAME_;
  " 2>&1 | sed 's/^/      /'
else
  echo "    ✅ 干净库：无既有 Flowable 表（不会与既有结构冲突）"
fi
echo

# ---------- 2. 业务表与数据量（评估备份/迁移窗口）----------
echo "[2] 业务规模（决定备份与迁移窗口）"
for t in flow_definition flow_instance_biz flow_task_log sys_user sys_role page_schema app; do
  EXISTS=$($PSQL -c "SELECT to_regclass('public.$t') IS NOT NULL;" 2>/dev/null)
  if [ "$EXISTS" = "t" ]; then
    N=$($PSQL -c "SELECT count(*) FROM $t;" 2>/dev/null)
    echo "    $t: $N 行"
  else
    echo "    $t: (表不存在)"
  fi
done
echo

# ---------- 3. 会话与锁（建表期间不能有长事务占用）----------
echo "[3] 当前连接与锁"
$PSQL -c "SELECT count(*) || ' 个活跃连接' FROM pg_stat_activity WHERE datname = '$DB_NAME';" 2>&1 | sed 's/^/    /'
$PSQL -c "
  SELECT count(*) || ' 个锁等待'
  FROM pg_locks WHERE NOT granted;
" 2>&1 | sed 's/^/    /'
echo

# ---------- 4. 磁盘空间（32 表 + 索引所需）----------
echo "[4] 磁盘空间"
$PSQL -c "SELECT pg_size_pretty(pg_database_size(current_database())) || ' 当前库大小';" 2>&1 | sed 's/^/    /'
if command -v df >/dev/null 2>&1; then
  DATA_DIR=$($PSQL -c "SHOW data_directory;" 2>/dev/null)
  df -h "$DATA_DIR" 2>/dev/null | tail -1 | sed 's/^/    磁盘: /'
fi
echo

# ---------- 5. Flyway 迁移状态（确认 V18 是否已应用）----------
echo "[5] Flyway 迁移状态"
$PSQL -c "
  SELECT version || ' | ' || description || ' | ' ||
         CASE WHEN success THEN 'SUCCESS' ELSE 'FAILED' END
  FROM flyway_schema_history
  WHERE version IS NOT NULL
  ORDER BY installed_rank DESC LIMIT 5;
" 2>&1 | sed 's/^/    /'
echo "    （V18__flow_tables.sql 应在此列表中；若未出现说明迁移未执行）"
echo

# ---------- 6. 关键结论 ----------
echo "============================================================"
echo " 结论"
echo "============================================================"
if [ "${COUNT:-0}" = "0" ]; then
  echo "  • 库干净，可安全启用 Flowable（首次启动自动建 32 张表）"
  echo "  • 预计新增：32 张表 + 约 130 个索引"
  echo "  • ACT_GE_PROPERTY.schema.version 将被置为 7.2.0.2"
else
  echo "  • 库中已有 Flowable 表，禁止重复初始化"
  echo "  • 请核对版本是否与本项目依赖（7.2.0）一致"
  echo "  • 版本不一致需走 Flowable 官方升级脚本，不能直接删除重建"
fi
echo "============================================================"