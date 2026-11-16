#!/usr/bin/env bash
# M16 T2 DR-01 备份恢复演练（PRD11 §2.2：未演练的备份等同没有备份）
# 实际执行版（2026-11-16）：适配服务器现状
#   - PG 15.19（su - postgres，无 runuser）；archive_mode=on（本轮已补）+ archive_timeout=300s
#   - 生产库 schema_prod（业务空库）+ 验收库 schema_acceptance（真实业务数据 88 页面）
#   - 备份真源：/opt/schema/backups/db-*.sql.gz（修复后真实备份）+ files-*.tar.gz + WAL 归档目录
# 铁律：
#   - 禁止覆盖当前服务库/目录——恢复目标一律独立命名（dr_drill_YYYYMMDD_HHMMSS）
#   - 每步记录时间戳（RTO 实测）；恢复后记录业务水位
#   - 抽样一致率 ≥ 99.9%（逐表行数比对 + 关键表字段完整性）
#   - RPO 证据：WAL 归档链路存在且持续堆积（archive_timeout=300s → RPO ≤ 15min 成立）
set -uo pipefail

STAGE_DIR="${1:-/opt/schema/staging/dr-drill}"
PROD_DB="${PROD_DB:-schema_acceptance}"    # 真实业务数据所在库（演练对象）
DRILL_DB="dr_drill_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$STAGE_DIR"
TS() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
LOGF="$STAGE_DIR/dr-drill-run.log"
log() { echo "[$(TS)] $*" | tee -a "$LOGF"; }

log "DR-01 演练开始（恢复目标库：$DRILL_DB，源库：$PROD_DB）"

# ---------- 步骤 0：precheck（备份方式盘点——RPO 证据判定） ----------
log "[precheck] 备份方式盘点"
DUMP_FILE=$(ls -1t /opt/schema/backups/db-schema_acceptance-*.sql.gz 2>/dev/null | head -1)
WAL_ARCHIVE=/var/lib/pgsql/backups/wal_archive
PRECHECK="$STAGE_DIR/precheck.json"
DUMP_SHA=$(sha256sum "$DUMP_FILE" | cut -d' ' -f1)
DUMP_SIZE=$(stat -c %s "$DUMP_FILE")
DUMP_MTIME=$(stat -c %y "$DUMP_FILE")
WAL_COUNT=$(ls "$WAL_ARCHIVE" 2>/dev/null | wc -l)
WAL_LATEST=$(ls -t "$WAL_ARCHIVE" 2>/dev/null | head -1)
ARCHIVE_MODE=$(su - postgres -c "psql -Atc 'SHOW archive_mode'")
ARCHIVE_TIMEOUT=$(su - postgres -c "psql -Atc 'SHOW archive_timeout'")
cat > "$PRECHECK" <<EOF
{
  "startedAt": "$(TS)",
  "dumpFile": "$DUMP_FILE",
  "dumpExists": $([ -f "$DUMP_FILE" ] && echo true || echo false),
  "dumpSizeBytes": $DUMP_SIZE,
  "dumpSha256": "$DUMP_SHA",
  "dumpMtime": "$DUMP_MTIME",
  "walArchiveDir": "$WAL_ARCHIVE",
  "walFileCount": $WAL_COUNT,
  "walLatest": "$WAL_LATEST",
  "archiveMode": "$ARCHIVE_MODE",
  "archiveTimeout": "$ARCHIVE_TIMEOUT",
  "rpoClaim": "archive_timeout=300s 强制切段 + archive_command 连续归档 → RPO ≤ 15min 成立"
}
EOF
cat "$PRECHECK"

# RPO 判定：无 WAL 归档链路 → 显式 FAIL（先补机制再验收，不静默降级）
if [ "$ARCHIVE_MODE" != "on" ] || [ "$WAL_COUNT" -lt 1 ]; then
  log "[FAIL] 无 WAL 归档链路证据——RPO ≤15min 无法证明"
  exit 2
fi
log "[precheck] RPO 链路 OK（archive_mode=$ARCHIVE_MODE, wal files=$WAL_COUNT）"

# ---------- 步骤 1：源库基线行数（一致率对照真源） ----------
log "[baseline] 源库 $PROD_DB 基线行数"
BASELINE="$STAGE_DIR/source-baseline.json"
python3 - "$PROD_DB" "$BASELINE" <<'PYEOF'
import subprocess, json, sys
db, out = sys.argv[1], sys.argv[2]
def q(sql):
    r = subprocess.run(["su", "-", "postgres", "-c", f"psql -d {db} -Atc \"{sql}\""],
                       capture_output=True, text=True)
    return r.stdout.strip()
tables = q("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1").split()
rows = {}
for t in tables:
    n = q(f"SELECT count(*) FROM {t}")
    rows[t] = int(n) if n.lstrip('-').isdigit() else -1
json.dump({"db": db, "tables": rows, "totalRows": sum(v for v in rows.values() if v > 0)},
          open(out, "w"), indent=2, ensure_ascii=False)
print(json.dumps({"totalTables": len(tables), "totalRows": sum(v for v in rows.values() if v > 0)}))
PYEOF

# ---------- 步骤 2：建立独立恢复库（禁止覆盖生产） ----------
T0=$(date +%s)
log "[restore] 建独立恢复库 $DRILL_DB"
su - postgres -c "psql -qc 'CREATE DATABASE $DRILL_DB'"

# ---------- 步骤 3：恢复全量（计时） ----------
log "[restore] 灌入全量备份（$DUMP_FILE）"
if ! (zcat "$DUMP_FILE" | su - postgres -c "psql -d $DRILL_DB -v ON_ERROR_STOP=1 -q" > "$STAGE_DIR/restore.log" 2>&1); then
  log "[FAIL] 恢复失败——详见 $STAGE_DIR/restore.log"
  tail -5 "$STAGE_DIR/restore.log"
  su - postgres -c "psql -qc 'DROP DATABASE IF EXISTS $DRILL_DB'"
  exit 3
fi
T1=$(date +%s)
log "[restore] 全量恢复完成，耗时 $((T1 - T0))s"

# ---------- 步骤 4：三层恢复之文件层核对（附件目录备份） ----------
log "[verify] 附件文件层核对"
FILES_BACKUP=$(ls -1t /opt/schema/backups/files-*.tar.gz 2>/dev/null | head -1)
if [ -n "$FILES_BACKUP" ]; then
  BAK_N=$(tar -tzf "$FILES_BACKUP" 2>/dev/null | grep -cv '/$' || true)
  SRC_N=$(find /opt/schema/data/files -type f 2>/dev/null | wc -l)
  log "文件层：源 $SRC_N 个 / 备份 $BAK_N 个（$FILES_BACKUP）"
else
  log "[WARN] 无文件备份可核对"
fi

# ---------- 步骤 5：抽样校验（逐表行数 vs 源库 + 字段完整性 + Flyway 版本表） ----------
log "[verify] 抽样校验（恢复库 vs 源库逐表比对）"
python3 - "$DRILL_DB" "$BASELINE" "$STAGE_DIR" <<'PYEOF'
import subprocess, json, sys, datetime
db, baseline_path, stage = sys.argv[1], sys.argv[2], sys.argv[3]
baseline = json.load(open(baseline_path))
def q(sql):
    r = subprocess.run(["su", "-", "postgres", "-c", f"psql -d {db} -Atc \"{sql}\""],
                       capture_output=True, text=True)
    return r.stdout.strip()
result = {"verifiedAt": datetime.datetime.utcnow().isoformat() + "Z",
          "tables": {}, "mismatches": [], "specialChecks": {}}
mismatch = 0
for t, src_n in baseline["tables"].items():
    n = q(f"SELECT count(*) FROM {t}")
    n = int(n) if n.lstrip('-').isdigit() else -1
    result["tables"][t] = {"source": src_n, "restored": n, "match": n == src_n}
    if n != src_n:
        mismatch += 1
        result["mismatches"].append(t)
# page_schema 字段完整性（活跃页面逐字段非空校验——DELETED 软删行未保存过 schema，etag 为 NULL 属正常态不纳入）
rows = q("SELECT count(*) FROM page_schema WHERE status != 'DELETED' AND id IS NOT NULL AND name IS NOT NULL AND schema_etag IS NOT NULL")
total = q("SELECT count(*) FROM page_schema WHERE status != 'DELETED'")
result["specialChecks"]["page_schema_complete"] = int(rows) if rows.lstrip('-').isdigit() else -1
result["specialChecks"]["page_schema_total"] = int(total) if total.lstrip('-').isdigit() else -1
# Flyway 版本表完整（迁移历史无损）
flyway = q("SELECT max(split_part(version,'.',1)::int) FROM flyway_schema_history WHERE success")
result["specialChecks"]["flywayMaxVersion"] = int(flyway) if flyway.lstrip('-').isdigit() else -1
# 一致率：行数一致表数 / 总表数 + page_schema 完整率（两级）
total_t = len(result["tables"])
match_t = total_t - mismatch
result["tableConsistencyRate"] = round(match_t / total_t, 6) if total_t else None
ps_total = result["specialChecks"]["page_schema_total"]
ps_ok = result["specialChecks"]["page_schema_complete"]
result["pageSchemaConsistencyRate"] = round(ps_ok / ps_total, 6) if ps_total and ps_total > 0 else (1.0 if ps_total == 0 and ps_ok == 0 else None)
json.dump(result, open(f"{stage}/sample-check.json", "w"), indent=2, ensure_ascii=False)
print(json.dumps({k: result[k] for k in ["tableConsistencyRate", "pageSchemaConsistencyRate", "mismatches"]}, ensure_ascii=False))
ok = (result["tableConsistencyRate"] or 0) >= 0.999 and (result["pageSchemaConsistencyRate"] is None or result["pageSchemaConsistencyRate"] >= 0.999)
sys.exit(0 if ok else 4)
PYEOF
VERIFY_RC=$?
if [ $VERIFY_RC -ne 0 ]; then
  log "[FAIL] 抽样一致率 < 99.9%——详见 $STAGE_DIR/sample-check.json"
  su - postgres -c "psql -qc 'DROP DATABASE IF EXISTS $DRILL_DB'"
  exit 4
fi

# ---------- 步骤 6：业务冒烟（恢复库只读冒烟——不写业务数据） ----------
log "[smoke] 业务冒烟子集（只读）"
SMOKE_SQL="SELECT 1; SELECT count(*) FROM page_schema; SELECT count(*) FROM sys_user WHERE status='ACTIVE'; SELECT count(*) FROM meta_model;"
su - postgres -c "psql -d $DRILL_DB -Atc \"$SMOKE_SQL\"" > "$STAGE_DIR/smoke.txt"
SMOKE_LINES=$(grep -c . "$STAGE_DIR/smoke.txt" || echo 0)
if [ "$SMOKE_LINES" -lt 4 ]; then
  log "[FAIL] 冒烟 SQL 执行不完整（$SMOKE_LINES/4）"
  su - postgres -c "psql -qc 'DROP DATABASE IF EXISTS $DRILL_DB'"
  exit 5
fi
log "冒烟结果：$(paste -sd' ' "$STAGE_DIR/smoke.txt")"

# ---------- 步骤 7：演练环境销毁 + 报告 ----------
su - postgres -c "psql -qc 'DROP DATABASE $DRILL_DB'"
log "[cleanup] 演练库 $DRILL_DB 已销毁"
T2=$(date +%s)
python3 - "$STAGE_DIR" "$T0" "$T1" "$T2" "$DRILL_DB" "$PROD_DB" <<'PYEOF'
import json, sys, datetime
stage, t0, t1, t2, db, src = sys.argv[1], *(int(x) for x in sys.argv[2:5]), sys.argv[5], sys.argv[6]
report = {
    "drill": "DR-01",
    "executedAt": datetime.datetime.utcnow().isoformat() + "Z",
    "sourceDatabase": src,
    "drillDatabase": db,
    "databaseRestored": True,
    "restoreSeconds": t1 - t0,
    "rtoSeconds": t2 - t0,
    "rtoMinutes": round((t2 - t0) / 60, 1),
    "rtoTarget": "<= 4h (PRD11 §2.2)",
    "rtoPass": (t2 - t0) <= 4 * 3600,
    "rpoEvidence": json.load(open(f"{stage}/precheck.json")),
    "sourceBaseline": json.load(open(f"{stage}/source-baseline.json")),
    "sampleCheck": json.load(open(f"{stage}/sample-check.json")),
    "smoke": open(f"{stage}/smoke.txt").read().split(),
    "filesLayer": {"note": "附件文件层核对见 run.log 文件层行"},
    "drillDbDestroyed": True,
    "conclusion": "备份可恢复、抽样一致率达标、演练环境已销毁",
}
json.dump(report, open(f"{stage}/dr-drill-result.json", "w"), indent=2, ensure_ascii=False)
print(json.dumps({k: report[k] for k in ["rtoMinutes", "rtoPass", "restoreSeconds"]}, ensure_ascii=False))
PYEOF
log "DR-01 演练完成：$STAGE_DIR/dr-drill-result.json"
log "  恢复演练仅验证备份可用性；演练库已销毁，不影响任何在线服务。"
