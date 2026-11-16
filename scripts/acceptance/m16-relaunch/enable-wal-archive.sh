#!/bin/bash
set -euo pipefail
# WAL 归档开启脚本（M16 T2 RPO≤15min 前提）：
# - archive_mode=on + archive_command=cp 到 /var/lib/pgsql/backups/wal_archive（已存在于 backups 目录）
# - archive_timeout=300s：5 分钟强制切段——空闲期也保证 RPO ≤15min（PRD11 §2.2）
# - 需要重启 PG——须确认执行窗口（生产服务会断连数秒，Spring Hikari 自动重连）
echo "[pre] 确认当前状态"
CUR_MODE=$(su - postgres -c "psql -Atc 'SHOW archive_mode'")
echo "archive_mode=$CUR_MODE"
if [ "$CUR_MODE" = "on" ] || [ "$CUR_MODE" = "always" ]; then
  echo "已开启，无需变更"; exit 0
fi

CONF=/var/lib/pgsql/data/postgresql.conf
echo "[1/5] 备份 postgresql.conf"
cp "$CONF" "$CONF.bak-$(date +%Y%m%d-%H%M%S)"

echo "[2/5] 写入归档配置（尾部追加标记块）"
cat >> "$CONF" <<'EOF'

# ==== M16 DR-01 WAL archiving (2026-11-16) ====
archive_mode = on
archive_command = 'test ! -f /var/lib/pgsql/backups/wal_archive/%f && cp %p /var/lib/pgsql/backups/wal_archive/%f'
archive_timeout = 300
EOF

mkdir -p /var/lib/pgsql/backups/wal_archive
chown -R postgres:postgres /var/lib/pgsql/backups

echo "[3/5] 重启 PostgreSQL"
systemctl restart postgresql
sleep 3

echo "[4/5] 验证"
su - postgres -c "psql -Atc 'SHOW archive_mode'"
su - postgres -c "psql -Atc 'SHOW archive_command'"
su - postgres -c "psql -Atc 'SHOW archive_timeout'"

echo "[5/5] 强制切段测试归档链路"
su - postgres -c "psql -c 'SELECT pg_switch_wal()'" >/dev/null
sleep 3
WAL_COUNT=$(ls /var/lib/pgsql/backups/wal_archive/ | wc -l)
echo "wal_archive files: $WAL_COUNT"
if [ "$WAL_COUNT" -lt 1 ]; then
  echo "FAIL: 归档目录为空——archive_command 未生效"; exit 1
fi
echo "WAL 归档链路就绪（RPO 证据：archive_timeout=300s + 连续归档文件）"
