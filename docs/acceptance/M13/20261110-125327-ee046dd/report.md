# M13 页面设计器与预览 — 同版本全链验收轮报告（run 20261110-125327-ee046dd）

- 执行时间：2026-11-10 12:53–13:02（UTC+8）
- 源码版本：ee046dda1c06387a73a11ee0fb1b7db10b2e2e85（受控提交，工作树干净——run.json workingTreeClean=true）
- 验收栈同源同版：本地 8090 代理 → SSH 隧道 18081 → 服务器验收后端（**受控构建 ee046dd**，identity verifiable=true，instanceId 6df2f8ea）；静态验收面部署哈希 28cd68af…（与本地 dist-accept 三面一致）
- 与上轮（20261110-122458-acf1f21）差异：上轮服务器后端仍运行 271bf21 构建，deployment 的 `commitMatchesSource=false` 触发 V2 门禁「Deployment response differs from tested artifact」。本轮以 ee046dd 受控构建替换服务器验收后端（JAR 上传哈希=本地构建哈希=10b7d0c7…），后端身份与验收源版本同 SHA，消除该缺口。

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

- 受控构建记录：out/builds/20261110-125030-ee046dd.json（backendIdentity=true，JAR 内 build-source.txt 校验通过；designer-accept sha256=28cd68af…2843、accept-backend sha256=10b7d0c7…33290）
- products.json：designer-accept sha256=28cd68af…2843（sourceCommit=ee046dd，runtimeVersion=28cd68af）
- stability.json：静态面前后一致 + 双构建哈希一致（build1=build2=28cd68af）+ 未认证路由探针 401
- deployment.json：静态面三面一致（before=after=localDist=28cd68af）；后端 build-identity before=after=**ee046dd**（与验收源版本同 commit，commitMatchesSource=true）、实例 UUID 前后一致（6df2f8ea）

## 边界如实登记

- 公网面 curl 直连 GET /api/auth/csrf 返回 401 不下发凭证（浏览器路径不受影响）——稳定性脚本登录态探针降级为未认证 401 判定
- 主套件 B2-4 字段下拉选项数少，不受虚拟滚动影响（实测全选项渲染）
- 验收期间替换了一次服务器后端进程（acf1f21 轮旧实例 8bc5888a → 本轮新实例 6df2f8ea）——替换发生在套件执行前，套件运行期间 deployment 采样前后实例一致
