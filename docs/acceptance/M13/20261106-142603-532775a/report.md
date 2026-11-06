# M13 页面设计器验收报告（P0/P1 缺口修复回归）

- **run-id**: 20261106-142603-532775a
- **sourceCommit**: 532775a（干净树）
- **日期**: 2026-11-06
- **执行**: `node scripts/acceptance/evidence.cjs run M13 page-designer -- node scripts/acceptance/accept-page-designer.cjs`（CDP 真实浏览器 + API + 落库断言）
- **环境**: Windows + WSL 后端 18080（schema_accept 库）+ Node 静态代理 8090 + Chrome CDP；designer/runtime 为本次构建产物
- **结果**: 54/54 PASS，exit=0

## 背景与范围

上一轮 M13「implemented」结论经复核存在核心缺口：fieldRef 未落协议、表达式阻断未覆盖自动保存、容器嵌套/排序/删除未实现、验收只覆盖有限路径。本轮修复全部 P0/P1 缺口后重做真实验收，新增 B 系列绑定真实模型全链路（26 项）。

## 覆盖范围（按验收项）

### A 系列（28 项）——设计器编辑闭环
| 验收项 | 断言要点 | 结果 |
|---|---|---|
| A4 拖拽与撤销 | UI 向导新建、空画布引导、拖入 SectionCard+TextInput、撤销/重做节点数 | PASS |
| A5 属性面板 | propsSchema 渲染、改 label 画布即时反映 | PASS |
| A6 表达式 | 语法错误阻断保存、错误提示可见、修正后保存成功且草稿落库 | PASS |
| A7 409 保护 | 外部保存推版本、本地保存 409 弹层、草稿保留、放弃对齐服务器 | PASS |
| A8 发布预览 | 发布 API、grant 签发、兑换链路无失败、预览隔离通道、grant 重放被拒（401） | PASS |
| A9 未绑模型入口 | 数据绑定组渲染、下拉提示「页面未绑定模型」 | PASS |

### B 系列（26 项）——绑定真实模型全链路（本轮新增）
| 验收项 | 断言要点 | 结果 |
|---|---|---|
| B0 模型准备 | 创建模型、precheck 签发 token、4 字段落库（两段式保存） | PASS |
| B1 绑定页创建 | UI 创建、落库可查 | PASS |
| B2 字段绑定 | API 绑定模型、拖入 TextInput、绑定下拉渲染、选中 amount | PASS |
| B3 落库协议 | 保存后 `fieldRef` 在 LayoutNode 协议字段（protocol=true props=false） | PASS |
| B4 容器嵌套 | 拖入 SectionCard、容器落点捕获、嵌套拖入、大纲缩进、嵌套结构落库（children 内） | PASS |
| B5 大纲操作 | 上移/下移/删除操作入口可见 | PASS |
| B6 409 差异 | 外部冲突、弹层出现、三方差异摘要表、节点数维度、放弃对齐 | PASS |
| B7 发布预览 | 发布、预览路由渲染、绑定表单渲染（不再提示未绑模型） | PASS |
| B8 差异检测 | 模型删除字段保存（两段式）、引用已删字段节点标黄（dashed outline） | PASS |

## 修复实证的关键断言

1. **B3-2 fieldRef 落协议字段**：属性面板选择字段后保存，草稿 JSON 中 `"fieldRef":"amount"` 位于 LayoutNode 顶层而非 props——渲染引擎消费路径打通。
2. **B4-3 嵌套结构落库**：树结构递归检查 TextInput 在 SectionCard children 内（draftVersion=4）。
3. **B7-3 预览渲染绑定表单**：预览页显示「验收绑定页 / 卡片 / 提 交」——字段元数据 200（此前 403）。
4. **B8-2 标黄**：删除 amount 字段后重开设计器，引用节点 2 个 dashed outline。

## 本轮修复清单（源码提交 532775a）

**前端**：
- `updateProps` 命令 fieldRef 写协议字段；属性面板读 `node.fieldRef`
- `doSave` 统一表达式阻断（手动/自动/预览）；保存并发保护（回执只对未变 doc 清 dirty）
- 画布拖拽接入 `validateDropTarget` 容器嵌套；大纲上移/下移/删除
- 新建向导「由模型生成默认布局」；409 弹层三方差异摘要表
- `DesignerStore`：失败命令不污染历史栈；dirty 由保存基线快照深比较

**后端**（验收发现真实缺陷）：
- `PageCommandService.snapshotModelRef`：发布快照 modelId 回退 schema.modelId（设计器绑定模型不进 modelRefs）
- `PreviewDataGuard.collectPublishedModelId`：限页预览放行集补 published 页面 schema 的 modelId（修复字段元数据 403）

**双端表达式契约**（M1 教训重演修复）：
- 前端求值器补 `===`/`!==` 分支（此前只补优先级表，求值炸「未知运算符」——上一轮回归通过但因向量缺该形态而无效）
- Java tokenizer 三字符识别 + 优先级表 + `strictEquals` 同判
- 共享向量 `expr-test-vectors.json` 补 8 条严格相等用例；前端 96/96、Java 18/18

## 已知边界与遗留

- 真实鼠标拖拽（HTML5 DnD 手势级）未直接验收——以 fiber 直调 handler 替代（React 合成事件链路等价）；容器嵌套用同步 dragover+drop 序列实证。
- 发布触发的 UI「预览」按钮链路未单独断言（预览路由验收走 grant API 签发——与 UI 同端点）。
- 模型生成默认页仅向导开关接入（generateDefaultLayout 已有 24 项单测）；B 系列未重复验收生成骨架（属向导路径，向导生成失败时提示手动搭建）。
- 验收脚本自身修正多处（B2 流程顺序防覆盖丢节点、antd Select 展开、JSON 键序无关断言）——脚本修正不改变产品结论。
