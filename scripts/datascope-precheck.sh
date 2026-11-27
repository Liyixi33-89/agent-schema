#!/usr/bin/env bash
# 发布前只读数据权限预检 —— 由 schema-release.sh 的 datascope-check 子命令调用。
#
# ## 执行身份
# 由 **root** 执行（经 deploy 的 sudo 白名单允许的 schema-release.sh），
# 内部用 runuser -u postgres 连库。因此 deploy 用户**不需要**任何 postgres 权限。
#
# ## 目标库白名单
# 只允许 schema_prod / schema_acceptance。库名不合法直接拒绝（防注入与误查）。
#
# ## 退出码契约（deploy.py 只依据退出码判断，不解析文案）
#   0 = 通过（无「缺少必要授权」的账号）
#   1 = strict 且存在「缺少必要授权」的账号 → 阻止发布
#   2 = 预检不可用（库不存在 / 连不上 / SQL 失败 / 参数非法）→ 阻止发布
#
# ## 两类 NO_SCOPE（关键语义）
# 不能要求「所有活跃账号都必须有数据范围」——那会逼人为了过门禁乱授 ALL。
#   · 预期拒绝   —— 本就不该有数据权限的账号，用 --expected-no-scope 显式声明；
#                    报告为 [INFO]，**不算失败**
#   · 缺少必要授权 —— 其余 NO_SCOPE 账号；strict 下阻止发布
#
# ## 纪律：只读
# 全部语句为 SELECT。缺范围是权限决策，必须由人按模型授予；
# 自动补 model_id=0 的 ALL 会把最小权限变成全员全量，是最危险的做法。
#
# ## 实现注意（都是实测踩过的坑，别改回去）
# 1. awk 的 -F 必须用 "$(printf '\t')"。写成 -F'$'\t'' 是引号拼接，
#    awk 收到字面量 `$\t` → $4 取不到 → 预检形同虚设（全 exit 0）。
# 2. `set -u` 下管道非零会让赋值「未定义」，后续报 unbound variable 并中止。
#    → 加 `|| true` 与 `${VAR:-}` 兜底。
# 3. here-string `<<<` 在严格模式下边界行为不稳 → 用临时文件迭代。
# 4. 不要 `2>/dev/null` 吞掉 SQL 错误：错误会被伪装成「无数据」，排查成本极高。

set -uo pipefail

DB="${1:-}"
STRICT=0
EXPECTED_NO_SCOPE=""
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --strict) STRICT=1 ;;
    --expected-no-scope)
      shift
      EXPECTED_NO_SCOPE="${1:-}"
      ;;
    --expected-no-scope=*)
      EXPECTED_NO_SCOPE="${1#--expected-no-scope=}"
      ;;
    *)
      echo "[datascope-precheck] 未知参数: $1" >&2
      exit 2
      ;;
  esac
  shift || break
done

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

# runuser 读不到 root 的 cwd 会打印干扰行
cd /tmp || exit 2

# 只读查询：SQL 经 -c 传入；不吞 stderr；校验退出码
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

# ---- 1. 账号有效数据范围（4 个独立列，psql -F 制表符分隔）----
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
    printf '%s %-24s roles=%-4s with_scope=%-4s %s\n' \
      "$mark" "$account" "$roles" "$scopes" "$verdict"
  done < <(printf '%s\n' "$ROWS")
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
      printf '  %-24s tenant=%s model=ALL_WILDCARD scope=%s expr=%s\n' \
        "$code" "$tenant" "$stype" "$sexpr"
    else
      printf '  %-24s tenant=%s model=%s scope=%s expr=%s\n' \
        "$code" "$tenant" "$mid" "$stype" "$sexpr"
    fi
  done < <(printf '%s\n' "$SCOPES")
fi

# ---- 4. 分类 NO_SCOPE 账号：预期拒绝 vs 缺少必要授权 ----
NO_SCOPE_LIST=$(printf '%s\n' "$ROWS" \
  | awk -F"$(printf '\t')" '$4 == "NO_SCOPE" {print $1}' || true)
NO_SCOPE_LIST="${NO_SCOPE_LIST:-}"

# 预期清单规范化（去空格 / 去空项）
EXP_NORM=$(printf '%s' "${EXPECTED_NO_SCOPE:-}" | tr -d ' ')

EXPECTED_HIT=""
UNEXPECTED=""

TMPLIST=$(mktemp) || { echo "[datascope-precheck] mktemp 失败" >&2; exit 2; }
trap 'rm -f "$TMPLIST"' EXIT
printf '%s\n' "$NO_SCOPE_LIST" > "$TMPLIST"

while IFS= read -r acc; do
  [ -z "$acc" ] && continue
  is_expected=0
  if [ -n "$EXP_NORM" ]; then
    case ",${EXP_NORM}," in
      *",${acc},"*) is_expected=1 ;;
    esac
  fi
  if [ "$is_expected" -eq 1 ]; then
    EXPECTED_HIT="${EXPECTED_HIT}${acc} "
  else
    UNEXPECTED="${UNEXPECTED}${acc} "
  fi
done < "$TMPLIST"

NO_SCOPE_COUNT=$(printf '%s' "$NO_SCOPE_LIST" | grep -c . || true)
UNEXPECTED_COUNT=$(printf '%s' "$UNEXPECTED" | tr ' ' '\n' | grep -c . || true)

# ---- 5. 结论 ----
echo ""
echo "--- 结论 ---"
if [ -n "$EXPECTED_HIT" ]; then
  echo "  [INFO] 预期无数据范围（已确认，不计为失败）: ${EXPECTED_HIT% }"
fi

if [ "${UNEXPECTED_COUNT:-0}" -eq 0 ]; then
  if [ "${NO_SCOPE_COUNT:-0}" -eq 0 ]; then
    echo "  [OK] 所有活跃账号均有数据范围"
  else
    echo "  [OK] 无「缺少必要授权」的账号（NO_SCOPE 均为预期拒绝）"
  fi
  exit 0
fi

echo "  [WARN] $UNEXPECTED_COUNT 个活跃账号缺少必要数据范围（业务数据默认不可见）"
echo "         ${UNEXPECTED% }"
echo ""
echo "  处置建议（本项目不做自动修改）："
echo "    1) 确认该账号实际需要哪些模型的数据权限"
echo "    2) 优先按模型授予（新建专用角色，避免改动共享角色影响他人）："
echo "       INSERT INTO sys_role_data_scope (role_id, model_id, scope_type, scope_expr)"
echo "       SELECT r.id, <model_id>, 'ALL', NULL FROM sys_role r"
echo "        WHERE r.code='<role>' AND r.tenant_id=<t>;"
echo "    3) 仅当确需租户全模型管理时，才用 model_id=0 的通配 ALL"
echo "    4) 配置后用该账号验证：列表 / 详情 / 聚合 / 流程发起"
echo "    5) 保留一个无授权账号做拒绝对照（证明限制真实生效）"
echo ""
echo "  若某账号**本就不该有数据权限**（如纯配置管理账号），不要给它授权——"
echo "  用 --expected-no-scope \"acc1,acc2\" 显式声明，预检会归为「预期拒绝」而非失败。"

if [ "$STRICT" -eq 1 ]; then
  echo ""
  echo "  [--strict] 存在缺范围账号 -> 退出码 1（阻止发布）"
  exit 1
fi
exit 0