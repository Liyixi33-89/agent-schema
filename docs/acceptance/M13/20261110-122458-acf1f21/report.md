# M13 页面设计器与预览 — 重验轮报告（run 20261110-122458-acf1f21）

- 执行时间：2026-11-10 12:24–12:29（UTC+8）
- 源码版本：acf1f21985f0ff757f1da5ab19e498211aa1fbc3（受控提交，工作树干净——本轮 run.json workingTreeClean=true）
- 重验原因：上轮归档 20261110-114619-271bf21 在验收执行后、归档提交前修改了 `scripts/` 下两个验收工具文件（race 套件虚拟滚动修复 + 产物配置 sourceCommit 更新），违反「sourceCommit→HEAD 实现路径不得变更」门禁；且上轮 run 始于脏工作树。本轮在同一受控提交 acf1f21（含全部工具修复）上以干净工作树完整重跑双套件与全部采样。
- 验收栈同源：本地 8090 代理 → SSH 隧道 18081 → 服务器验收后端（受控构建 271bf21，identity verifiable=true，instanceId 8bc5888a）；静态验收面部署哈希 28cd68af…（与本地 dist-accept 三面一致）

## 套件结果

| 套件 | 结果 | 说明 |
|---|---|---|
| page-designer-race | 32/32 PASS | C1 模型生成默认页 + C2 CDP 真实鼠标拖拽 + C3 自动保存竞态门控 + C3b 30s 定时器 + C4 409 三路径闭环 |
| page-designer | 54/54 PASS | A4-A9 编辑内核/属性面板/表达式/409/发布预览 + B0-B8 绑定模型全链 |

关键证据：
- C2 真实输入形态：`cdp-real-mouse (isTrusted=true, dragstart=1, drop=1)`——CDP Input.dispatchMouseEvent 真实鼠标序列驱动浏览器原生 HTML5 拖拽源（非页面 JS 派发事件链）
- C4-3b/c 草稿完整保留：画布节点数≥2、期间编辑仍在画布、服务器冲突态如实不含本地内容；保留本地并准备替换后服务器内容被本地替换
- C3 门控竞态：PUT in-flight 挂起窗口内继续编辑，回执不吞 dirty，内容最终落库、版本链推进

## 产物来源与部署采样（同 run）

- products.json：designer-accept sha256=28cd68af…2843（sourceCommit=acf1f21，runtimeVersion=28cd68af）
- stability.json：静态面前后一致 + 双构建哈希一致（build1=build2=28cd68af）+ 未认证路由探针 401
- deployment.json：静态面三面一致（before=after=localDist=28cd68af）；后端 build-identity before=after=271bf21、实例 UUID 前后一致

## 后端版本口径如实登记

服务器验收后端运行 271bf21 受控构建，与本轮验收源版本 acf1f21 不同 SHA。经 git 实证：271bf21→acf1f21 之间 `schema-platform/` 零文件变更（backendDeltaSinceBuild=[]），后端构建对当前源码等价成立；差异仅为验收脚本与归档材料（不参与后端运行时行为）。deployment.json 按脚本设计如实记录 `commitMatchesSource=false` + 空 delta，不硬判失败。

## 与上轮（20261110-114619-271bf21）差异说明

- 上轮 run 始于脏工作树（workingTreeClean=false），且归档提交 acf1f21 相对 sourceCommit 271bf21 变动了 `scripts/` 两文件，触发 references 门禁「implementation changed since sourceCommit」与「working tree was not clean」
- 本轮在 acf1f21 干净工作树上重跑：双套件同 run 同部署同源码版本，全部采样（products/stability/deployment）在同 run 内完成
- 本轮起 workingTreeClean=true、sourceCommit=HEAD=acf1f21，证据提交后无实现路径变更，门禁可长期复验通过

## 边界如实登记

- 公网面 curl 直连 GET /api/auth/csrf 返回 401 不下发凭证（浏览器路径不受影响）——稳定性脚本登录态探针降级为未认证 401 判定
- 主套件 B2-4 字段下拉选项数少，不受虚拟滚动影响（实测全选项渲染）
