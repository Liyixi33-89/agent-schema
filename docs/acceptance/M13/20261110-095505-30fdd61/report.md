# M13 页面设计器与预览 — 最终验收轮报告（run 20261110-095505-30fdd61）

- 执行时间：2026-11-10 09:55–10:02（UTC+8）
- 源码版本：30fdd61768a27e0f40032087d948787f94aac452（受控提交，工作树干净）
- 验收栈：本地 8090 静态代理 → SSH 隧道 18081 → 服务器验收后端（schema_acceptance 库）；静态验收面 http://111.231.57.177/accept/designer/（部署哈希 28cd68af…，与本地 dist-accept 三面一致）
- 上轮遗留缺口处置：
  - C2 合成事件 → 本轮升级双形态：CDP Input.dispatchMouseEvent 真实鼠标序列（浏览器输入管线 isTrusted=true）为主路径；实测 dragstart=1、drop=1，真实 HTML5 拖拽会话成立，未触发降级回退
  - C4-3b/c 新增草稿完整保留断言（画布节点数≥2 + 期间编辑仍在画布 + 服务器冲突态如实不含本地内容）
  - 稳定性采样升级双构建实测（两次独立构建哈希一致）+ 未认证路由探针（401=路由存在且鉴权生效）

## 套件结果

| 套件 | 结果 | 说明 |
|---|---|---|
| page-designer-race | 32/32 PASS | C1 模型生成 4 + C2 真实拖拽 2 + C3 竞态 7 + C3b 定时器 2 + C4 409 闭环 6 + 登录 1；退出码 0 |
| page-designer | 54/54 PASS | A4-A9 编辑内核/属性面板/表达式/409/发布预览 + B0-B8 绑定模型全链；退出码 0 |

真实拖拽形态记录（race C2-1）：`cdp-real-mouse (isTrusted=true, dragstart=1, drop=1)`——真实输入管线驱动浏览器原生 HTML5 拖拽源，非页面 JS 派发。

## 产物来源与部署采样

- products.json：designer-accept（dist-accept/index.html，sha256=28cd68af…2843，bytes=391，sourceCommit=30fdd61）
- stability.json：静态面前后一致（28cd68af）；双构建哈希一致（build1=build2=28cd68af）；未认证 /api/apps → 401（路由存在，鉴权生效）
- deployment.json：静态面 before=after=本地 dist-accept 哈希（三面一致）；后端 build-identity commitId=4ab57bb、实例 UUID 前后一致；backendDeltaSinceBuild 为空数组（git 实证 4ab57bb→30fdd61 之间 schema-platform/ 零变更——本轮全部改动为前端配置/验收脚本，不影响已部署后端行为）

## 验收工具链修整（本轮提交 d887e75 + 30fdd61）

- deploy-accept-static.sh 从说明形态升级为完整可执行部署链（webroot 对齐 nginx alias /opt/schema/staging/accept/designer）
- server-seed-accept-data.sh 权限授予失败显式暴露（psql 退出码+落库计数双检；实测 page:design=1、app:publish=2）
- stability-sample.sh 双构建实测确定性 + WSL→Windows 构建回退链（powershell.exe 显式 cd + ACCEPT_BASE 透传）+ pipefail 下 grep 无匹配兜底
- cdp.cjs 新增 mouseDrag/centerOf（真实鼠标序列能力沉淀）
- .gitignore 补 dist-accept/（构建产物不入 git）

## CI 独立审计

PR #4 verify 工作流对 30fdd61 绿勾（GitHub Actions 实测，非自报）：https://github.com/Liyixi33-89/agent-schema/actions/runs/42738267046

## 边界如实登记

- 公网面 GET /api/auth/csrf 对 curl 直连返回 401 且不下发凭证（浏览器路径先经登录页初始化）——登录态路由探针降级为未认证 401 判定（路由存在且鉴权链生效）；浏览器套件内真实登录链路不受影响
- 后端部署版本仍为 4ab57bb（验收面后端未随本轮前端工具提交重建）——backendDeltaSinceBuild 空数组实证零后端源码变更，符合「验收面后端按需重建」口径；若要求后端与 HEAD 严格同版，需服务器重建后再采一轮
