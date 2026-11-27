#!/usr/bin/env bash
# 发布前只读权限预检：报告「无有效数据范围」的账号。
#
# ## 为什么需要
# 2026-11-27 资源级授权上线后，IamDataPermissionAdapter.resolveScopes() 只消费
# **用户实际持有角色**上的范围；无匹配范围时 ScopeResolver 返回 1 = 0（默认拒绝）。
# 于是「有很多管理员角色」不等于「能读业务数据」——生产 admin 有 22 个角色但
# 0 个带范围，上线后 50 个模型的数据全部不可见。
#
# ## 纪律：只读，绝不自动修
# 本脚本只用 SELECT。缺范围属于权限决策，必须由人按模型授予：
#   · 优先按具体模型授权（model_id=<id>）
#   · 只有明确需要租户全模型管理时才批准 model_id=0 的通配 ALL
#
# ## 用法
#   bash datascope-precheck.sh <db_name> [--strict]
#     退出码 0 = 无风险（或未开 strict）
#            1 = 存在 NO_SCOPE 账号且开了 --strict
#            2 = 查询失败（库不存在/无法连接）——调用方应视为「无法确认」而拒绝发布
#
# ## 实现注意（踩过的坑，别改回去）
# · 分隔符用制表符而非 `|`：`psql -F'|'` 的竖线在函数/命令替换上下文会被
#   shell 误当管道符（报 syntax error near unexpected token '('）
# · SQL 走独立 .sql 文件再由 psql -f 执行：heredoc + 函数 + 命令替换三层嵌套时
#   stdin 传递不可靠（实测表格输出为空），且多行 SQL 里的 '(null)' 极易触发引号问题

set -uo pipefail

DB="${1:-}"
STRICT=0
if [ "${2:-}" = "--strict" ]; then STRICT=1; fi

if [ -z "$DB" ]; then
  echo "用法: $0 <db_name> [--strict]" >&2
  exit 2
fi

# sudo -u postgres 读不到当前目录（root 700）时会打印干扰行——切到 /tmp
cd /tmp || exit 2

# 库存在性（查不到 ≠ 没问题，必须区分）
exists=$(sudo -u postgres psql -t -A -d postgres 2>/dev/null \
  -c "SELECT 1 FROM pg_database WHERE datname = '$DB'")
if [ "$exists" != "1" ]; then
  echo "[datascope-precheck] 数据库不存在或无法查询: $DB" >&2
  exit 2
fi

echo "[datascope-precheck] 目标库: $DB"

# 把三段查询写成临时 SQL 文件，逐段 psql -f 执行（避免任何 shell 解析）
# SQL 文本（变量承载，经 -c 传入）。内部只用单引号字面量，无双引号——
# 与 -c "$SQL" 的双引号包裹不冲突。
# 字段间用 E'\\t'（SQL 层拼制表符），下游 read 用 $'\\t' 对齐。
# 注意：SELECT 出 **4 个独立列**（由 psql -F 制表符分隔），
# **不要**把它们 `|| E'\t' ||` 拼成一个字段——那样 ORDER BY 4 会指向
# 不存在的列，PostgreSQL 报 "ORDER BY position 4 is not in select list"，
# 而 2>/dev/null 会把错误吞掉，表现为「查询失败或无活跃账号」。
SQL_ACCOUNTS=$(cat <<'SQL'
SELECT u.account,
       count(DISTINCT ur.role_id),
       count(DISTINCT s.role_id),
       CASE WHEN count(DISTINCT s.role_id) = 0 THEN 'NO_SCOPE'
            WHEN bool_or(s.scope_type = 'ALL') THEN 'ALL'
            ELSE 'LIMITED' END
FROM sys_user u
LEFT JOIN sys_user_role ur      ON ur.user_id = u.id
LEFT JOIN sys_role_data_scope s ON s.role_id  = ur.role_id
WHERE u.status = 'ACTIVE'
GROUP BY u.account
ORDER BY 4 DESC, u.account
SQL
)

SQL_MODELS=$(cat <<'SQL'
SELECT count(*) FROM meta_model
SQL
)

# 同样输出独立列（见上：拼接会让列变成 1 个，任何按位置引用都会失效）
SQL_SCOPES=$(cat <<'SQL'
SELECT r.code, r.tenant_id, s.model_id, s.scope_type, COALESCE(s.scope_expr, '-')
FROM sys_role_data_scope s JOIN sys_role r ON r.id = s.role_id
ORDER BY r.code, s.model_id
SQL
)

run_sql() {
  # SQL 经 -c 传入（不用 -f 临时文件：sudo 切用户后可能读不到 mktemp 目录）。
  # ⚠️ 不要 2>/dev/null 吞掉 stderr：SQL 错误会被伪装成「查询失败或无数据」，
  # 排查时完全看不到真实原因（本轮为此多花了 4 轮）。错误直接透出。
  sudo -u postgres psql -d "$DB" -t -A -F "$(printf '\t')" -c "$1" 2>&1
}

echo ""
echo "--- 账号有效数据范围 ---"
ROWS=$(run_sql "$SQL_ACCOUNTS")
if [ -z "$ROWS" ]; then
  echo "  查询失败或无活跃账号" >&2
  exit 2
fi
while IFS=$'\t' read -r account roles scopes verdict; do
  [ -z "${account:-}" ] && continue
  case "$verdict" in
    NO_SCOPE) mark='  [WARN]' ;;
    ALL)      mark='  [ OK ]' ;;
    *)        mark='  [ .. ]' ;;
  esac
  printf '%s %-24s roles=%-4s with_scope=%-4s %s\n' "$mark" "$account" "$roles" "$scopes" "$verdict"
done <<< "$ROWS"
echo ""

MODELS=$(run_sql "$SQL_MODELS")
echo "--- 影响面 ---"
echo "  未删除模型数: ${MODELS:-未知}（NO_SCOPE 账号对这些模型的数据一律 1=0 不可见）"
echo ""

echo "--- 现有数据范围记录 ---"
SCOPES=$(run_sql "$SQL_SCOPES")
if [ -z "$SCOPES" ]; then
  echo "  （无任何数据范围记录）"
else
  while IFS=$'\t' read -r code tenant mid stype sexpr; do
    [ -z "${code:-}" ] && continue
    if [ "$mid" = "0" ]; then
      printf '  %-24s tenant=%s model=ALL_WILDCARD scope=%s expr=%s\n' "$code" "$tenant" "$stype" "$sexpr"
    else
      printf '  %-24s tenant=%s model=%s scope=%s expr=%s\n' "$code" "$tenant" "$mid" "$stype" "$sexpr"
    fi
  done <<< "$SCOPES"
fi
echo ""

NO_SCOPE_COUNT=$(printf '%s\n' "$ROWS" | grep -c 'NO_SCOPE$' || true)

echo "--- 结论 ---"
if [ "${NO_SCOPE_COUNT:-0}" -eq 0 ]; then
  echo "  [OK] 所有活跃账号均有数据范围"
  exit 0
fi

echo "  [WARN] $NO_SCOPE_COUNT 个活跃账号无任何数据范围（业务数据默认不可见）"
echo ""
echo "  处置建议（本项目不做自动修改）："
echo "    1) 确认该账号实际需要哪些模型的数据权限"
echo "    2) 优先按模型授予："
echo "       INSERT INTO sys_role_data_scope (role_id, model_id, scope_type, scope_expr)"
echo "       SELECT r.id, <model_id>, 'ALL', NULL FROM sys_role r"
echo "        WHERE r.code='<role>' AND r.tenant_id=<t>;"
echo "    3) 仅当确需租户全模型管理时，才用 model_id=0 的通配 ALL"
echo "    4) 配置后用该账号验证：列表 / 详情 / 聚合 / 流程发起"
echo "    5) 保留一个无授权账号做拒绝对照（证明限制真实生效）"

if [ "$STRICT" -eq 1 ]; then
  echo ""
  echo "  [--strict] 存在缺范围账号 -> 退出码 1"
  exit 1
fi
exit 0