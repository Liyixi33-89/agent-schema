#!/usr/bin/env bash
# 发布前只读权限预检：报告「无有效数据范围」的账号。
#
# ## 为什么需要
# 2026-11-27 资源级授权上线后，`IamDataPermissionAdapter.resolveScopes()` 只消费
# **用户实际持有角色**上的范围；无匹配范围时 `ScopeResolver` 返回 `1 = 0`（默认拒绝）。
# 于是「有很多管理员角色」不等于「能读业务数据」——生产 admin 有 22 个角色但
# 0 个带范围，上线后业务数据全部不可见。
#
# ## 纪律：只读，绝不自动修
# 本脚本**只读**（只用 SELECT）。缺范围属于权限决策，必须由人按模型授予：
#   · 优先按具体模型授权（model_id=<id>）
#   · 只有明确需要租户全模型管理时才批准 model_id=0 的通配 ALL
# 自动批量补 ALL 会把「最小权限」变成「全员全量」，是最危险的做法。
#
# ## 用法
#   bash datascope-precheck.sh <db_name> [--strict]
#     <db_name>  目标库（如 schema_prod / schema_acceptance）
#     --strict   存在 NO_SCOPE 账号时退出码 1（发布门禁用）
#
# 退出码：0 = 无风险（或非 strict）；1 = 存在缺范围账号且 --strict；2 = 查询失败
set -uo pipefail

DB="${1:-}"
STRICT=0
if [ "${2:-}" = "--strict" ]; then STRICT=1; fi

if [ -z "$DB" ]; then
  echo "用法: $0 <db_name> [--strict]" >&2
  exit 2
fi

PSQL="sudo -u postgres psql -d $DB -t -A -F|"

# sudo -u postgres 不能读当前目录（root 700）时 psql 会打印
# "could not change directory to ..."，污染表格输出——统一切到 /tmp 再跑。
cd /tmp || exit 2

# 库不存在直接报错（不要静默通过——「查不到」不等于「没问题」）
# 用 psql -c 而非 psql -lqt：后者在部分环境下受权限/输出格式影响会误判
if ! sudo -u postgres psql -t -A -d postgres \
       -c "SELECT 1 FROM pg_database WHERE datname = '$DB'" 2>/dev/null | grep -q '^1

echo "[datascope-precheck] 目标库: $DB"
echo ""

# ---------- 1. 账号级判定 ----------
echo "--- 账号有效数据范围 ---"
ROWS=$($PSQL -c "
  SELECT u.account,
         count(DISTINCT ur.role_id)                                   AS role_cnt,
         count(DISTINCT s.role_id)                                    AS scope_cnt,
         CASE WHEN count(DISTINCT s.role_id) = 0 THEN 'NO_SCOPE'
              WHEN bool_or(s.scope_type = 'ALL') THEN 'ALL'
              ELSE 'LIMITED' END                                      AS verdict
  FROM sys_user u
  LEFT JOIN sys_user_role ur      ON ur.user_id = u.id
  LEFT JOIN sys_role_data_scope s ON s.role_id  = ur.role_id
  WHERE u.status = 'ACTIVE'
  GROUP BY u.account
  ORDER BY verdict DESC, u.account" 2>&1)

if [ $? -ne 0 ] || [ -z "$ROWS" ]; then
  echo "  查询失败或无数据：$ROWS" >&2
  exit 2
fi

echo "$ROWS" | while IFS='|' read -r account roles scopes verdict; do
  case "$verdict" in
    NO_SCOPE) mark="  ⚠️ " ;;
    ALL)      mark="  ✅ " ;;
    *)        mark="  ·  " ;;
  esac
  printf '%s%-24s roles=%-4s with_scope=%-4s %s\n' "$mark" "$account" "$roles" "$scopes" "$verdict"
done
echo ""

# ---------- 2. 影响面 ----------
MODELS=$($PSQL -c "SELECT count(*) FROM meta_model" 2>/dev/null)
echo "--- 影响面 ---"
echo "  未删除模型数: ${MODELS:-未知}（NO_SCOPE 账号对这些模型的数据一律 1=0 不可见）"
echo ""

# ---------- 3. 已有范围记录 ----------
echo "--- 现有数据范围记录 ---"
$PSQL -c "
  SELECT r.code, r.tenant_id, s.model_id, s.scope_type, COALESCE(s.scope_expr, '(null)')
  FROM sys_role_data_scope s JOIN sys_role r ON r.id = s.role_id
  ORDER BY r.code, s.model_id" 2>/dev/null | while IFS='|' read -r code tenant mid stype sexpr; do
  if [ "$mid" = "0" ]; then
    printf '  %-24s tenant=%s model=ALL_WILDCARD scope=%s expr=%s\n' "$code" "$tenant" "$stype" "$sexpr"
  else
    printf '  %-24s tenant=%s model=%s scope=%s expr=%s\n' "$code" "$tenant" "$mid" "$stype" "$sexpr"
  fi
done
echo ""

# ---------- 4. 结论 ----------
NO_SCOPE_COUNT=$(echo "$ROWS" | awk -F'|' '$4 == "NO_SCOPE"' | wc -l | tr -d ' ')
echo "--- 结论 ---"
if [ "$NO_SCOPE_COUNT" -eq 0 ]; then
  echo "  ✅ 所有活跃账号均有数据范围"
  exit 0
fi

echo "  ⚠️  $NO_SCOPE_COUNT 个活跃账号无任何数据范围（业务数据默认不可见）"
echo ""
echo "  处置建议（本项目不做自动修改）："
echo "    1) 确认该账号实际需要哪些模型的数据权限"
echo "    2) 优先按模型授予："
echo "       INSERT INTO sys_role_data_scope (role_id, model_id, scope_type, scope_expr)"
echo "       SELECT r.id, <model_id>, 'ALL', NULL FROM sys_role r WHERE r.code='<role>' AND r.tenant_id=<t>;"
echo "    3) 仅当确需租户全模型管理时，才用 model_id=0 的通配 ALL"
echo "    4) 配置后用该账号验证：列表 / 详情 / 聚合 / 流程发起"
echo "    5) 保留一个无授权账号做拒绝对照（证明限制真实生效）"

if [ "$STRICT" -eq 1 ]; then
  echo ""
  echo "  [--strict] 存在缺范围账号 → 退出码 1"
  exit 1
fi
exit 0; then
  echo "[datascope-precheck] 数据库不存在或无法查询: $DB" >&2
  exit 2
fi

echo "[datascope-precheck] 目标库: $DB"
echo ""

# ---------- 1. 账号级判定 ----------
echo "--- 账号有效数据范围 ---"
ROWS=$($PSQL -c "
  SELECT u.account,
         count(DISTINCT ur.role_id)                                   AS role_cnt,
         count(DISTINCT s.role_id)                                    AS scope_cnt,
         CASE WHEN count(DISTINCT s.role_id) = 0 THEN 'NO_SCOPE'
              WHEN bool_or(s.scope_type = 'ALL') THEN 'ALL'
              ELSE 'LIMITED' END                                      AS verdict
  FROM sys_user u
  LEFT JOIN sys_user_role ur      ON ur.user_id = u.id
  LEFT JOIN sys_role_data_scope s ON s.role_id  = ur.role_id
  WHERE u.status = 'ACTIVE'
  GROUP BY u.account
  ORDER BY verdict DESC, u.account" 2>&1)

if [ $? -ne 0 ] || [ -z "$ROWS" ]; then
  echo "  查询失败或无数据：$ROWS" >&2
  exit 2
fi

echo "$ROWS" | while IFS='|' read -r account roles scopes verdict; do
  case "$verdict" in
    NO_SCOPE) mark="  ⚠️ " ;;
    ALL)      mark="  ✅ " ;;
    *)        mark="  ·  " ;;
  esac
  printf '%s%-24s roles=%-4s with_scope=%-4s %s\n' "$mark" "$account" "$roles" "$scopes" "$verdict"
done
echo ""

# ---------- 2. 影响面 ----------
MODELS=$($PSQL -c "SELECT count(*) FROM meta_model" 2>/dev/null)
echo "--- 影响面 ---"
echo "  未删除模型数: ${MODELS:-未知}（NO_SCOPE 账号对这些模型的数据一律 1=0 不可见）"
echo ""

# ---------- 3. 已有范围记录 ----------
echo "--- 现有数据范围记录 ---"
$PSQL -c "
  SELECT r.code, r.tenant_id, s.model_id, s.scope_type, COALESCE(s.scope_expr, '(null)')
  FROM sys_role_data_scope s JOIN sys_role r ON r.id = s.role_id
  ORDER BY r.code, s.model_id" 2>/dev/null | while IFS='|' read -r code tenant mid stype sexpr; do
  if [ "$mid" = "0" ]; then
    printf '  %-24s tenant=%s model=ALL_WILDCARD scope=%s expr=%s\n' "$code" "$tenant" "$stype" "$sexpr"
  else
    printf '  %-24s tenant=%s model=%s scope=%s expr=%s\n' "$code" "$tenant" "$mid" "$stype" "$sexpr"
  fi
done
echo ""

# ---------- 4. 结论 ----------
NO_SCOPE_COUNT=$(echo "$ROWS" | awk -F'|' '$4 == "NO_SCOPE"' | wc -l | tr -d ' ')
echo "--- 结论 ---"
if [ "$NO_SCOPE_COUNT" -eq 0 ]; then
  echo "  ✅ 所有活跃账号均有数据范围"
  exit 0
fi

echo "  ⚠️  $NO_SCOPE_COUNT 个活跃账号无任何数据范围（业务数据默认不可见）"
echo ""
echo "  处置建议（本项目不做自动修改）："
echo "    1) 确认该账号实际需要哪些模型的数据权限"
echo "    2) 优先按模型授予："
echo "       INSERT INTO sys_role_data_scope (role_id, model_id, scope_type, scope_expr)"
echo "       SELECT r.id, <model_id>, 'ALL', NULL FROM sys_role r WHERE r.code='<role>' AND r.tenant_id=<t>;"
echo "    3) 仅当确需租户全模型管理时，才用 model_id=0 的通配 ALL"
echo "    4) 配置后用该账号验证：列表 / 详情 / 聚合 / 流程发起"
echo "    5) 保留一个无授权账号做拒绝对照（证明限制真实生效）"

if [ "$STRICT" -eq 1 ]; then
  echo ""
  echo "  [--strict] 存在缺范围账号 → 退出码 1"
  exit 1
fi
exit 0