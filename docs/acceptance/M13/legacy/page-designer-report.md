# M13 页面设计器验收报告

- **run-id**: page-designer（本地验收环境）
- **日期**: 2026-11-06
- **执行**: `node scripts/acceptance/accept-page-designer.cjs`（CDP 真实浏览器 + API + 落库断言）
- **结果**: 28/28 PASS（详见 `page-designer-result.json`）
- **环境**: WSL PG 16（schema_accept 库）+ 后端 18080 + Node 静态代理 8090（designer/runtime dist）

## 验收矩阵（规格 013 §5）

| 项 | 内容 | 结果 |
|---|---|---|
| A4-1~2 | UI 向导新建页面 + 空画布引导 | PASS |
| A4-3~7 | 拖入 SectionCard/TextInput、节点渲染、撤销减一、重做恢复 | PASS |
| A5-1~3 | propsSchema 属性面板、改 label 即时反映画布 | PASS |
| A6-1~3 | 错误表达式标红 + 保存按钮阻断 | PASS |
| A6-4~6 | 修正后保存成功、页面落库、草稿含表达式 | PASS |
| A7-1~4 | 外部保存推版本 → 409 冲突弹层 → 保留草稿（input value 断言）→ 显式放弃对齐 | PASS |
| A8-1~3 | 发布、grant 签发、exchange 换 15min 会话 | PASS |
| A8-4 | 发布面可读（预览 token 匿名隔离通道） | PASS |
| A8-5~6 | 预览路由渲染「预览模式」、兑换链路无失败 | PASS |
| A8-7 | grant 重放被拒（一次性） | PASS |
| A9-1 | 未绑模型页字段绑定入口（数据绑定组渲染） | PASS |

## 单测面

- `@schema/page-designer`: 24/24（命令系统/撤销重做/落点校验负例/默认页生成/表达式校验/面板元数据/大纲树）
- 回归：schema-protocol 88、schema-form 32、data-model-designer 39、renderer/materials 全绿
- verify[quick] PASS（证据门禁 20/20、台账门禁 20/20）

## 过程中发现并修复的真实缺陷

1. **协议表达式引擎 `===`/`!==` 优先级缺失**（M1 冻结缺陷）：tokenize 能识别三字符操作符但
   BINARY_PRECEDENCE 表无项 → parseExpr 当 trailing 拒绝 → 所有 `a === b` 表达式编译失败。
   修复：优先级表补 `'===': 3, '!==': 3`。schema-protocol 88 项回归通过。
2. **预览路由登录态 Cookie 撞通道隔离**：浏览器打开 `#/preview?grant=` 时自动附带 schema_at
   Cookie，exchange 端点按 03BE §4.1 通道强制隔离拒 Cookie 凭证（PREVIEW_CREDENTIAL_REJECTED）。
   修复：exchange fetch 显式 `credentials:'omit'`（前端剥离，不动后端安全契约）。
3. **exchange 响应字段名对齐**：后端契约 `accessToken`（非 previewToken），runtime PreviewPage 修正。

## 已知边界（登记，不阻断）

- 验收页未绑模型 → 预览页显示「页面未绑定数据模型」（业务预期）；绑模型页的字段绑定/差异检测
  标黄为单测覆盖 + 代码路径同构，浏览器面以数据绑定组渲染为准。
- 拖拽采用 fiber 直调同步 onDrop（HTML5 DnD 的合成 DragEvent 在 React 18 委托层不被拾取——
  与 M12 教训同源，脚本内已注明）。
