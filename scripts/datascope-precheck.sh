#!/usr/bin/env bash
# 发布前只读数据权限预检 —— 由 schema-release.sh 的 datascope-check 子命令调用。
#
# ## 执行身份
# 本脚本由 **root** 执行（经 deploy 的 sudo 白名单允许的 schema-release.sh）。
# 内部用 runuser -u postgres 连库——因此 deploy 用户**不需要**任何 postgres 权限。
#
# ## 为什么不接受任意脚本
# 预检脚本安装在 root 属主、非 schema 可写的目录（/usr/local/sbin），
# 且本文件不接收「执行哪个脚本」的参数——避免变成「root 执行任意代码」。
#
# ## 目标库白名单
# 只允许 schema_prod / schema_acceptance。库名不合法直接拒绝（防 SQL 注入与误查）。
#
# ## 退出码契约（deploy.py 依据退出码判断，不解析文案）
#   0 = 预检通过（无 NO_SCOPE 账号，或非 strict 且只有警告）
#   1 = strict 且存在 NO_SCOPE 账号 → 阻止发布
#   2 = 预检不可用（库不存在 / 连不上 / SQL 失败 / 参数非法）→ 阻止发布
#
# ## 纪律：只读
# 全部语句为 SELECT。缺数据范围是权限决策，必须由人按模型授予；
# 自动补 model_id=0 的 ALL 会把最小权限变成全员全量，是最危险的做法。

set -uo pipefail

DB="${1:-}"
STRICT=0
if [ "${2:-}" = "--strict" ]; then STRICT=1; fi

# ---- 目标库白名单 ----
case "$DB" in
  schema_prod|schema_acceptance) : ;;
  *)
    echo "[datascope-precheck] 目标库不在白名单（仅允许 schema_prod / schema_acceptance）: ${DB:-<空>}" >&2
    exit 2
    ;;
esac

if [ "$(id -u)" != "0" ]; then
  echo "[datascope-precheck] 必须以 root 执行（由 schema-release.sh 白名单调用）" >&2
  exit 2
fi

# runuser 不继承 cwd 问题（postgres 读不到 root 的目录会打印干扰行）
cd /tmp || exit 2

# 统一的只读查询入口：参数是 SQL 文本。
# ⚠️ 不吞 stderr：SQL 错误必须可见（曾被 2>/dev/null 伪装成「无数据」，多花数轮排查）。
# ⚠️ 校验退出码：非 0 一律按「预检不可用」返回，绝不把错误文本当数据。
ro() {
  local sql="$1" out rc
  out=$(runuser -u postgres -- psql -d "$DB" -t -A -F "$(printf '\t')" -c "$sql" 2>&1)
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "[datascope-precheck] SQL 执行失败（db=$DB, rc=$rc）:" >&2
    printf '%s\n' "$out" | sed 's/^/  /' >&2
    return 2
  fi
  printf '%s\n' "$out"
  return 0
}

echo "[datascope-precheck] 目标库: $DB (strict=$STRICT)"

# ---- 0. 库存在 ----
if ! ro "SELECT 1 FROM pg_database WHERE datname = '$DB'" | grep -qx '1'; then
  echo "[datascope-precheck] 数据库不存在或不可查询: $DB" >&2
  exit 2
fi

# ---- 1. 账号有效数据范围 ----
# 4 个独立列（psql -F 制表符分隔）。**不要**拼成一个字段——
# 那样 ORDER BY 4 会指向不存在的列（PostgreSQL 报错），且错误易被忽略。
SQL_ACCOUNTS="
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
ORDER BY 4 DESC, u.account"

ROWS=$(ro "$SQL_ACCOUNTS") || exit 2

echo ""
echo "--- 账号有效数据范围 ---"
if [ -z "$ROWS" ]; then
  echo "  （无活跃账号）"
else
  while IFS=$'\t' read -r account roles scopes verdict; do
    [ -z "${account:-}" ] && continue
    case "$verdict" in
      NO_SCOPE) mark='  [WARN]' ;;
      ALL)      mark='  [ OK ]' ;;
      *)        mark='  [ .. ]' ;;
    esac
    printf '%s %-24s roles=%-4s with_scope=%-4s %s\n' "$mark" "$account" "$roles" "$scopes" "$verdict"
  done <<< "$ROWS"
fi

# ---- 2. 影响面 ----
MODELS=$(ro "SELECT count(*) FROM meta_model") || exit 2
echo ""
echo "--- 影响面 ---"
echo "  未删除模型数: ${MODELS:-未知}（NO_SCOPE 账号对这些模型的数据一律 1=0 不可见）"

# ---- 3. 现有范围记录 ----
SQL_SCOPES="
SELECT r.code, r.tenant_id, s.model_id, s.scope_type, COALESCE(s.scope_expr, '-')
FROM sys_role_data_scope s JOIN sys_role r ON r.id = s.role_id
ORDER BY r.code, s.model_id"
SCOPES=$(ro "$SQL_SCOPES") || exit 2

echo ""
echo "--- 现有数据范围记录 ---"
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

# ---- 4. 结论 ----
NO_SCOPE_COUNT=$(printf '%s\n' "$ROWS" | grep -c 'NO_SCOPE$' || true)

echo ""
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
  echo "  [--strict] 存在缺范围账号 -> 退出码 1（阻止发布）"
  exit 1
fi
exit 0