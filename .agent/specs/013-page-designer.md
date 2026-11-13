---
spec_id: 013-page-designer
status: active
milestone: M13               # 依赖图 §3.4；前置 M6-M7（accepted）、M11（accepted）
created: 2026-11-06
last_verified_at: 2026-11-13
owner: human-lead
---

# Spec · M13 页面设计器与预览

> 真源：详细 PRD 02《页面设计器》；详细前端技术文档 04《页面设计器 Canvas 引擎》；
> 后端 04《页面服务与编译服务》§A.1/§A.2/§A.4/§A.7（已实现——本规格消费不重定义）；
> 台账验收项：拖拽、propsSchema 属性面板、字段绑定、发布预览真实交互。

## 1. 背景与目标

页面设计器把「模型」变成「可用页面」。M6-M7 已交付渲染内核与表单引擎、M11 已交付运行时宿主
（FormPageHost）、M4 已交付页面服务（草稿乐观锁/发布快照/预览凭证）。缺的是**可视化编辑层**：
`packages/page-designer` 目前是空壳（`export {}`），designer 应用没有页面画布入口。
本任务交付 P1 编辑闭环：模型生成默认页 → 拖拽编辑 → 属性绑定 → 保存 → 发布 → 预览真实渲染，
且**设计器画布与运行时共享同一渲染核心**（schema-renderer + component-materials）。

## 2. 范围声明

**做**（P1——M13 台账验收四要素全覆盖）：
- 页面列表入口：新建（空白页/由模型生成）、删除、路径设置（复制降级为延后项，见「不做」）；
- 设计器工作区三栏：物料面板（分组）、画布（DesignMode 渲染）、属性面板 + 大纲树；
- 拖拽：物料面板 → 画布插入；画布内上移/下移；大纲树定位与排序；容器嵌套（深度≤8、禁自嵌套、容器白名单）；
- 编辑内核：命令系统（Insert/Move/UpdateProps/Delete），撤销重做 50 步快照栈；
- 属性面板：由物料 `propsSchema` 自动生成；字段绑定下拉（ACTIVE 可选、DELETED 置灰警示）；
- 表达式：`visibleWhen/disabledWhen/requiredWhen` 设计态 L1 校验（错误标红，阻断保存）；
- 保存：手动保存 + 30s 节流自动保存；`baseDraftVersion` 乐观锁 409 → 草稿保留 + 显式「放弃我的修改/覆盖」；
- 发布预览：发布走既有 `/api/apps/{appId}/publish`；预览走既有 grant→exchange 短时凭证链；
- 模型差异检测：引用 DELETED/不存在字段的节点标黄，不阻断编辑；
- 默认页生成：前端由模型字段生成表单页布局（协议 `defaultWidgetFor` 真源）。

**不做**（防范围蔓延，逐条写明推迟阶段）：
- 编辑锁 `/lock` 心跳（04BE §A.3 后端未实现；草稿乐观锁已防并发覆盖，锁服务整体随 Redis 化分期——M16 前评估）；
- 列表页设计器专项（列配置/筛选区/导出——随 M15 报销列表需求落地）；
- 动作绑定六类编排（TRIGGER_FLOW/CALL_API/OPEN_PAGE 等——依赖 M14/M15 流程与 API 注册）；
- L2 脚本编辑器与编译轨道（M14）；
- 仪表盘设计器、24 列栅格、主题变量定制、断点级移动配置（P2）；
- 移动端设计器编辑（设计器 PC Only；画布提供 375px 预览切换）；
- 页面复制端点（04BE §A.1 有定义、后端未实现——新建向导可覆盖主路径，登记延后项）；
- React Query / Zustand / Immer / @dnd-kit 新依赖引入——现有栈（React 18 + antd）内自实现，
  拖拽用原生 HTML5 DnD（与 M12 自实现画布同基线）。

## 3. 接口契约

### 3.1 后端既有端点（消费，不重定义）

| 端点 | 用途 | 已验收出处 |
|---|---|---|
| `POST /api/pages` `{appId,pageKey,name,type,modelId?,path}` | 新建（返回 `{id, draftVersion}`） | PageServiceIT |
| `GET /api/pages?appId=` / `GET /api/pages/{id}/draft` | 列表 / 草稿读取 `{schema, draftVersion}` | PageServiceIT |
| `PUT /api/pages/{id}/draft` `{schema, baseDraftVersion}` | 保存草稿（409 DRAFT_VERSION_CONFLICT） | PageServiceIT |
| `DELETE /api/pages/{id}` / `PUT /api/pages/{id}/path` | 删除 / 路径设置 | PageServiceIT |
| `POST /api/apps/{appId}/publish` | 发布（发布面协议校验严格一档） | PageServiceIT |
| `POST /api/apps/{appId}/preview-grants` → `POST /api/preview/exchange` | 短时单次预览凭证 → 15min 预览会话 | PageSecurityChainIT |
| `GET /api/runtime/pages/{pageId}` | 预览渲染读取（预览限页 + ETag） | PageSecurityChainIT |
| `GET /api/models/{id}`（X-App-Id） | 字段绑定下拉元数据源 | M12 已验 |

### 3.2 page-designer 包导出（前端契约，实现可换）

```ts
// packages/page-designer/src
export interface DesignerCommand { ... }         // Insert/Move/UpdateProps/Delete/UpdatePageProps
export class DesignerStore {                     // 编辑内核（框架无关，可单测）
  execute(cmd): void; undo(): boolean; redo(): boolean;
  get doc(): PageSchema; get dirty(): boolean;
  canUndo/canRedo; markSaved(draftVersion: number): void;
}
export function validateDropTarget(doc, targetParentId, draggingIds): { ok: boolean; reason?: string };
export function generateDefaultLayout(fields: FieldSchema[]): LayoutNode[];   // 模型生成默认页
export function collectFieldRefs(layout: LayoutNode[]): Set<string>;          // 差异检测输入
export const MATERIAL_PANEL: PanelGroup[];       // 物料面板分组清单（ componentName 真源自 component-materials ）
```

### 3.3 物料元数据扩展（component-materials 包，向后兼容）

`MaterialMeta` 增加可选字段（不破坏既有注册方）：
`propsSchema?: PropSchemaGroup[]`（属性面板生成输入）、`defaultProps?: Record<string, PropValue>`、
`acceptChildren?: boolean`（容器投放声明——FormItem/SectionCard/GroupCollapse/StepsWizard 为 true）。
`PropSchemaGroup` 定义于 page-designer（不进 schema-renderer 协议面——渲染核心不消费设计态元数据）。

### 3.4 designer 应用路由

工作台新增「页面」页签（与模型/成员/导航并列）：列表 → 「设计」进入画布全屏视图。
预览按钮：签发 grant → 新窗口打开 `runtime` 预览路由（preview channel 复用 M11 request.ts 双通道）。

## 4. Tasks

- [ ] T1 编辑内核：DesignerStore 命令系统 + 撤销重做栈（50 步）+ dirty 追踪（单测覆盖）
- [ ] T2 落点校验：validateDropTarget（容器白名单/深度≤8/自嵌套/移动子树）+ generateDefaultLayout
- [ ] T3 物料元数据：MaterialMeta 扩展 propsSchema/defaultProps/acceptChildren + 15 物料登记
- [ ] T4 属性面板：propsSchema → 表单渲染（复用 schema-form 输入通道或 antd 薄表单）+ 字段绑定下拉
- [ ] T5 画布 DesignMode：schema-renderer wrapNode 包装选中/标黄 + HTML5 DnD 落点指示
- [ ] T6 大纲树：组件树渲染、点击定位、上移/下移排序（复用命令系统）
- [ ] T7 保存链路：手动 + 30s 自动保存 + 409 冲突弹层（草稿保留/放弃/覆盖）
- [ ] T8 页面列表入口 + 新建向导（空白/模型生成）+ 删除/路径设置
- [ ] T9 发布 + 预览：publish 接线 + grant/exchange + runtime 预览路由
- [ ] T10 差异检测：collectFieldRefs + DELETED 节点标黄 + 保存警示（不阻断）
- [ ] T11 表达式设计态校验：L1 校验接线（协议 ExprEngine 真源）错误标红阻断保存
- [ ] T12 单测 + 浏览器验收脚本 + 证据归档

## 5. Acceptance（对应台账唯一验收项 page-designer 的完整拆解）

- [ ] A1 编辑内核：任意命令序列 undo/redo 后 doc 深比较相等；栈容量 50 截断；dirty 状态机正确（单测）
- [ ] A2 落点校验负例：非容器/超深/自嵌套/移动子树含目标四种落点全拒（单测）
- [ ] A3 模型生成默认页：字段类型→物料映射正确（enum→SelectInput、date→DateInput、computed→LabelText），required→FormItem required（单测）
- [ ] A4 拖拽真实交互：物料面板拖入画布成节点；容器嵌套生效；上移/下移/删除经命令系统可撤销（浏览器验收）
- [ ] A5 属性面板：选中节点按 propsSchema 渲染配置项；改 label 即时反映画布；字段绑定仅 ACTIVE 可选、DELETED 置灰（浏览器验收）
- [ ] A6 表达式：visibleWhen 语法错误设计态标红且保存被阻断；正确表达式保存成功（浏览器验收）
- [ ] A7 保存冲突：外部保存制造 409 → 设计器冲突弹层 → 草稿保留 → 显式放弃后可继续编辑（浏览器验收）
- [ ] A8 发布预览闭环：设计器保存 → 发布 → grant/exchange 预览渲染与画布一致；未发布改动不出现在预览（浏览器验收）
- [ ] A9 差异检测：模型删字段后画布对应节点标黄；存量页面正常渲染不报错（浏览器验收）
- [ ] A10 verify -Level commit 七步全绿；浏览器验收脚本全 PASS 并归档证据

## 6. 验证步骤

```text
1. pnpm --filter @schema/page-designer test && pnpm --filter @schema/designer typecheck
2. powershell -File scripts\verify.ps1 -Level quick
3. 浏览器验收：node scripts/acceptance/accept-page-designer.cjs（新建→生成→拖拽→属性→表达式→保存→409→发布→预览→差异检测）
4. powershell -File scripts\verify.ps1 -Level commit（证据归档 + 门禁）
```

## 7. 沉淀记录（结项时回填）

- **协议缺陷修复**：expression.ts BINARY_PRECEDENCE 缺 `===`/`!==`——tokenize 识别但 parse 无优先级
  当 trailing 拒绝，全部严格相等表达式编译失败（M1 冻结漏网；向量文件无该形态用例）。已补表项，
  schema-protocol 88 项回归通过。教训：**双端向量执行只覆盖了出现的形态，未覆盖"语义上显然该有"
  的形态**——契约测试用例设计须含操作符全家族。
- **预览路由 Cookie 撞隔离**：浏览器登录态下打开 `#/preview?grant=` 自动附 schema_at Cookie，
  exchange 按 03BE §4.1 拒 Cookie 凭证（PREVIEW_CREDENTIAL_REJECTED）。修复：前端 fetch 显式
  `credentials:'omit'`（匿名消费 grant 与协议设计一致，不动后端安全链）。
- **React 18 合成 DragEvent 不被委托层拾取**：dispatchEvent(DragEvent) 原样冒泡但 React onDrop
  不响应（drop 非可信事件链）；fiber 直调同步 onDrop 可靠（M12 教训复用）。验收脚本已注明。
- **工具栏按钮定位**：antd Tabs 隐藏页签残留 DOM 含同名按钮（主题页「保存变更」）——全局按钮
  查找必须限定容器（「返回列表」祖先中按钮数最多的一层）。
- **input value 不进 innerText**：保留草稿断言须读 input.value（属性面板值），bodyText 永远查不到。
- **预览 exchange 契约**：响应 `{accessToken, pageId, expiresIn}`（无 previewToken/tenantId）——
  preview JWT 内嵌 tenant claim 由服务端解析。
- 验收 28/28：新建向导/拖拽撤销重做/属性面板即时反映/表达式阻断保存/409 三路径（保留+放弃）/
  发布/grant 一次性/预览隔离通道/数据绑定组渲染。

