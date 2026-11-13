#!/bin/bash
# M13 服务器验收 seed：经真实 API 建「报销管理」应用完整数据链（服务器本机打 18081）
set -e
BASE=${1:-http://127.0.0.1:18081}
JAR=$(mktemp)

csrf() { grep schema_csrf "$JAR" | awk '{print $7}'; }
api() {
  local m=$1 p=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -s -b "$JAR" -c "$JAR" -X "$m" "$BASE$p" -H "Content-Type: application/json" \
      -H "X-CSRF-Token: $(csrf)" -H "Origin: $BASE" ${EXTRA_HDR:+-H "$EXTRA_HDR"} -d "$body"
  else
    curl -s -b "$JAR" -c "$JAR" -X "$m" "$BASE$p" -H "X-CSRF-Token: $(csrf)" -H "Origin: $BASE" ${EXTRA_HDR:+-H "$EXTRA_HDR"}
  fi
}

curl -s -c "$JAR" "$BASE/api/auth/csrf" -o /dev/null
api POST /api/auth/login '{"username":"accept_admin","password":"Accept!2026"}' -o /dev/null
echo "login OK"

# 幂等：已有同名应用直接复用
EXISTING=$(api GET "/api/apps?keyword=%E6%8A%A5%E9%94%80%E7%AE%A1%E7%90%86")
APP_ID=$(echo "$EXISTING" | sed -n 's/.*"list":\[{"id":\([0-9]*\).*/\1/p')
if [ -z "$APP_ID" ]; then
  APP=$(api POST /api/apps '{"name":"报销管理","description":"M13 浏览器验收应用"}')
  APP_ID=$(echo "$APP" | sed -n 's/.*"appId":\([0-9]*\).*/\1/p')
fi
echo "app: $APP_ID"

EXTRA_HDR="X-App-Id: $APP_ID"
MLIST=$(api GET "/api/models?appId=$APP_ID")
MDL_ID=$(echo "$MLIST" | sed -n 's/.*"modelKey":"expense","id":"\([0-9]*\)".*/\1/p')
if [ -z "$MDL_ID" ]; then
  MDL_ID=$(echo "$MLIST" | sed -n 's/.*{"id":"\([0-9]*\)","modelKey":"expense".*/\1/p')
fi
if [ -z "$MDL_ID" ]; then
  MDL=$(api POST /api/models '{"modelKey":"expense","name":"报销单"}')
  MDL_ID=$(echo "$MDL" | sed -n 's/.*"id":"\([0-9]*\)".*/\1/p')
fi
EXTRA_HDR=""
echo "model: $MDL_ID"

CHANGES='[
 {"op":"ADD_FIELD","fieldKey":"title","field":{"type":"text","label":"报销事由","required":true}},
 {"op":"ADD_FIELD","fieldKey":"amount","field":{"type":"number","label":"金额","required":true}},
 {"op":"ADD_FIELD","fieldKey":"expenseDate","field":{"type":"date","label":"报销日期"}},
 {"op":"ADD_FIELD","fieldKey":"remark","field":{"type":"text","label":"备注"}}
]'
PRE=$(EXTRA_HDR="X-App-Id: $APP_ID" api POST /api/models/$MDL_ID/precheck "{\"changes\":$CHANGES,\"baseVersion\":1}")
TOKEN=$(echo "$PRE" | sed -n 's/.*"confirmToken":"\([^"]*\)".*/\1/p')
SAVE=$(EXTRA_HDR="X-App-Id: $APP_ID" api POST /api/models/$MDL_ID/schema "{\"changes\":$CHANGES,\"baseVersion\":1,\"confirmToken\":\"$TOKEN\"}")
echo "saveSchema: $(echo $SAVE | head -c 120)"

# 幂等：已有同 pageKey 页面直接复用
PLIST=$(api GET "/api/pages?appId=$APP_ID")
PAGE_ID=$(echo "$PLIST" | sed -n 's/.*"pageKey":"expense_form"[^}]*"id":"\([0-9]*\)".*/\1/p')
if [ -z "$PAGE_ID" ]; then
  PAGE_ID=$(echo "$PLIST" | sed -n 's/.*"id":"\([0-9]*\)","pageKey":"expense_form".*/\1/p')
fi
if [ -z "$PAGE_ID" ]; then
  PAGE=$(api POST /api/pages "{\"appId\":$APP_ID,\"pageKey\":\"expense_form\",\"name\":\"报销登记\",\"type\":\"FORM\",\"modelId\":$MDL_ID,\"path\":\"/expense/form\"}")
  PAGE_ID=$(echo "$PAGE" | sed -n 's/.*"id":"\([0-9]*\)".*/\1/p')
fi
echo "page(form): $PAGE_ID"

# 当前导航版本（幂等重跑：首次 0，之后 +1；接口返回 {"tree":[...],"version":N}）
NAV_CUR=$(api GET "/api/apps/$APP_ID/nav" | sed -n 's/.*"version":\([0-9]*\).*/\1/p')
[ -z "$NAV_CUR" ] && NAV_CUR=0
NAV_BASE=$NAV_CUR

DRAFT=$(cat <<EOF
{"schema":{
 "id":"accept_form_1","pageKey":"expense_form","name":"报销登记","type":"FORM",
 "modelId":"$MDL_ID","path":"/expense/form","schemaVersion":1,
 "layout":[
  {"id":"fw1","componentName":"FormItem","props":{"label":"报销事由"},"children":[
    {"id":"f1","componentName":"TextInput","fieldRef":"title","props":{"placeholder":"请输入报销事由"}}]},
  {"id":"fw2","componentName":"FormItem","props":{"label":"金额"},"children":[
    {"id":"f2","componentName":"NumberInput","fieldRef":"amount","props":{}}]},
  {"id":"fw3","componentName":"FormItem","props":{"label":"报销日期"},"children":[
    {"id":"f3","componentName":"DateInput","fieldRef":"expenseDate","props":{}}]},
  {"id":"fw4","componentName":"FormItem","props":{"label":"备注"},"children":[
    {"id":"f4","componentName":"RichtextInput","fieldRef":"remark","props":{}}]},
  {"id":"f5","componentName":"PrimaryButton","props":{"label":"提交","actionType":"submit"}}
 ],
 "dataSource":null,"actions":[]},
 "baseDraftVersion":1}
EOF
)
# dataSource 定义为 object 不接受 null——协议非必填，删除该键
DRAFT=$(echo "$DRAFT" | sed 's/ "dataSource":null,//')
# 幂等草稿保存：先查当前 draftVersion 再以它为 base
DRAFT_CUR=$(api GET "/api/pages/$PAGE_ID/draft" | sed -n 's/.*"draftVersion":\([0-9]*\).*/\1/p')
[ -z "$DRAFT_CUR" ] && DRAFT_CUR=1
DRAFT=$(echo "$DRAFT" | sed "s/\"baseDraftVersion\":1}/\"baseDraftVersion\":$DRAFT_CUR}/")
api PUT /api/pages/$PAGE_ID/draft "$DRAFT" -o /dev/null
echo "draft saved"

NAV="{\"tree\":[
 {\"id\":\"g1\",\"type\":\"GROUP\",\"label\":\"报销中心\",\"children\":[
  {\"id\":\"p1\",\"type\":\"PAGE\",\"label\":\"报销登记\",\"refId\":$PAGE_ID}
 ]},
 {\"id\":\"l1\",\"type\":\"LINK\",\"label\":\"帮助中心\",\"url\":\"https://example.com/help\"}
],\"version\":$NAV_BASE}"
NAVRES=$(api PUT /api/apps/$APP_ID/nav "$NAV")
echo "nav: $(echo $NAVRES | head -c 80)"

# 成员角色：user（使用）+ developer（设计能力——页面/模型设计器验收必需，缺 developer
# 会被 DesignGate 拒（PERM_DENIED），向导模型下拉为空、生成开关不渲染）
api POST /api/apps/$APP_ID/members "{\"userId\":2,\"roles\":[\"user\",\"developer\"]}" -o /dev/null
echo "member added"

# 权限点授予：页面域判定走 sys_role_permission 权限点（PagePermGate）而非角色码——
# 成员 API 只写 sys_user_role，developer/app_admin 需显式授 page:design / app:publish
# （幂等；直连本机 PG——服务器验收栈专用；失败必须显式暴露，禁止吞错报成功）
PGOUT=$(APP_ID_VALUE=$APP_ID sudo -u postgres psql -d schema_acceptance -tA <<PGSQL
INSERT INTO sys_role_permission (role_id, resource_type, resource_id, action)
SELECT r.id, 'ACTION', 0, 'page:design' FROM sys_role r WHERE r.tenant_id=1 AND r.app_id=\${APP_ID_VALUE} AND r.code='developer'
ON CONFLICT DO NOTHING;
INSERT INTO sys_role_permission (role_id, resource_type, resource_id, action)
SELECT r.id, 'ACTION', 0, 'app:publish' FROM sys_role r WHERE r.tenant_id=1 AND r.app_id=\${APP_ID_VALUE} AND r.code IN ('developer','app_admin')
ON CONFLICT DO NOTHING;
SELECT 'page:design', count(*) FROM sys_role_permission rp JOIN sys_role r ON r.id=rp.role_id
WHERE r.tenant_id=1 AND r.app_id=\${APP_ID_VALUE} AND rp.action='page:design';
SELECT 'app:publish', count(*) FROM sys_role_permission rp JOIN sys_role r ON r.id=rp.role_id
WHERE r.tenant_id=1 AND r.app_id=\${APP_ID_VALUE} AND rp.action='app:publish';
PGSQL
)
if [ $? -ne 0 ]; then echo "PERM SEED FAIL: psql exit non-zero"; exit 1; fi
DESIGN_CNT=$(echo "$PGOUT" | sed -n 's/^page:design|\([0-9]*\)$/\1/p')
PUBLISH_CNT=$(echo "$PGOUT" | sed -n 's/^app:publish|\([0-9]*\)$/\1/p')
[ -n "$DESIGN_CNT" ] && [ "$DESIGN_CNT" -ge 1 ] || { echo "PERM SEED FAIL: page:design 未落库"; exit 1; }
[ -n "$PUBLISH_CNT" ] && [ "$PUBLISH_CNT" -ge 1 ] || { echo "PERM SEED FAIL: app:publish 未落库"; exit 1; }
echo "perms seeded (page:design=$DESIGN_CNT app:publish=$PUBLISH_CNT)"

PUB=$(api POST /api/apps/$APP_ID/publish '{"changelog":"M13 验收首次发布"}')
echo "publish: $(echo $PUB | head -c 120)"

echo "== DONE app=$APP_ID model=$MDL_ID page=$PAGE_ID =="
rm -f "$JAR"
