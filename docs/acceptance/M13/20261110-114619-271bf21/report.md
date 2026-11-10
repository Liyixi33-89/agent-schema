# M13 页面设计器与预览 — 最终验收轮报告（run 20261110-114619-271bf21）

- 执行时间：2026-11-10 11:46–11:52（UTC+8）
- 源码版本：271bf2104c78f051ebab7b65b1657c32a35584ad（受控提交，工作树干净）
- 验收栈同源：本地 8090 代理 → SSH 隧道 18081 → 服务器验收后端（受控构建 271bf21，identity verifiable=true，instanceId 8bc5888a）；静态验收面部署哈希 28cd68af…（与本地 dist-accept 三面一致）

## 套件结果

| 套件 | 结果 | 说明 |
|---|---|---|
| page-designer-race | 32/32 PASS | C1 模型生成默认页 + C2 真实鼠标拖拽 + C3 自动保存竞态门控 + C3b 30s 定时器 + C4 409 三路径闭环 |
| page-designer | 54/54 PASS | A4-A9 编辑内核/属性面板/表达式/409/发布预览 + B0-B8 绑定模型全链 |

关键证据：
- C2 真实输入形态：`cdp-real-mouse (isTrusted=true, dragstart=1, drop=1)`——CDP Input.dispatchMouseEvent 真实鼠标序列驱动浏览器原生 HTML5 拖拽源（非页面 JS 派发事件链）
- C4-3b/c 草稿完整保留：画布节点数≥2、期间编辑仍在画布、服务器冲突态如实不含本地内容；保留本地并准备替换后服务器内容被本地替换
- C3 门控竞态：PUT in-flight 挂起窗口内继续编辑，回执不吞 dirty，内容最终落库、版本链推进

## 产物来源与部署采样（同 run）

- products.json：designer-accept sha256=28cd68af…2843（sourceCommit=271bf21，runtimeVersion=28cd68af）
- stability.json：静态面前后一致 + 双构建哈希一致（build1=build2=28cd68af）+ 未认证路由探针 401
- deployment.json：静态面三面一致；后端 build-identity before=after=271bf21（与验收源版本同 commit）、实例 UUID 前后一致

## 与上轮（20261110-095505-30fdd61）差异说明

上轮后端仍为 4ab57bb 旧构建，「验收面后端与源版本同版」未闭环。本轮：
- 受控构建 271bf21（identity 注入）替换服务器验收后端，identity 实测 verifiable=true、commitId=271bf21
- 双套件在同一 run、同一部署、同一源码版本完整重跑（上轮分落两个 run 的口径问题消除）
- 修复两处验收脚本时序缺陷：应用卡片点击轮询（异步加载 flake）、模型下拉虚拟滚动到底（antd Select 只渲染可视区，「报销单」排底部不滚动不可见）

## 边界如实登记

- 公网面 curl 直连 GET /api/auth/csrf 返回 401 不下发凭证（浏览器路径不受影响）——稳定性脚本登录态探针降级为未认证 401 判定
- 主套件 B2-4 字段下拉选项数少，不受虚拟滚动影响（实测全选项渲染）
