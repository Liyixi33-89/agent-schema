# M13 页面设计器验收报告（P0/P1 缺口修复回归·最终）

- **run-id**: 20261106-152504-6d8257e
- **sourceCommit**: 6d8257e（最终代码树，含向量补充）
- **日期**: 2026-11-06
- **执行**: `node scripts/acceptance/evidence.cjs run M13 page-designer -- node scripts/acceptance/accept-page-designer.cjs`（CDP 真实浏览器 + API + 落库断言）
- **环境**: Windows + WSL 后端 18080（schema_accept 库）+ Node 静态代理 8090 + Chrome CDP；designer/runtime 为本次构建产物
- **结果**: 54/54 PASS，exit=0

## 背景

上一轮 M13「implemented」结论经复核存在核心缺口：fieldRef 未落协议、表达式阻断未覆盖自动保存、容器嵌套/排序/删除未实现、验收只覆盖有限路径。本轮修复全部 P0/P1 缺口后重做真实验收，新增 B 系列绑定真实模型全链路（26 项）。首个隔离运行 20261106-142603-532775a（54/54）后在独立评审中补充跨类型严格相等向量（源码变更），按门禁要求在最终代码树重跑本运行。

## 覆盖范围

### A 系列（28 项）——设计器编辑闭环
| 验收项 | 断言要点 | 结果 |
|---|---|---|
| A4 拖拽与撤销 | UI 向导新建、空画布引导、拖入 SectionCard+TextInput、撤销/重做节点数 | PASS |
| A5 属性面板 | propsSchema 渲染、改 label 画布即时反映 | PASS |
| A6 表达式 | 语法错误阻断保存、错误提示可见、修正后保存成功且草稿落库 | PASS |
| A7 409 保护 | 外部保存推版本、本地保存 409 弹层、草稿保留、放弃对齐服务器 | PASS |
| A8 发布预览 | 发布 API、grant 签发、兑换链路无失败、预览隔离通道、grant 重放被拒（401） | PASS |
| A9 未绑模型入口 | 数据绑定组渲染、下拉提示「页面未绑定模型」 | PASS |

### B 系列（26 项）——绑定真实模型全链路
| 验收项 | 断言要点 | 结果 |
|---|---|---|
| B0 模型准备 | 创建模型、precheck 签发 token、4 字段落库（两段式保存，enumOptions 带 status） | PASS |
| B1 绑定页创建 | UI 创建、落库可查 | PASS |
| B2 字段绑定 | API 绑定模型（拖入前——防覆盖丢节点）、拖入 TextInput、绑定下拉渲染、选中 amount | PASS |
| B3 落库协议 | 保存后 `fieldRef` 在 LayoutNode 协议字段（protocol=true props=false） | PASS |
| B4 容器嵌套 | 拖入 SectionCard、容器落点捕获（同框 dragover+drop）、大纲缩进、嵌套结构落库（children 内，树结构递归断言） | PASS |
| B5 大纲操作 | 上移/下移/删除操作入口可见 | PASS |
| B6 409 差异 | 外部冲突、弹层出现、三方差异摘要表、节点数维度、放弃对齐 | PASS |
| B7 发布预览 | 发布、预览路由渲染、绑定表单渲染（不再提示未绑模型；字段元数据 200——preview guard 修复实证） | PASS |
| B8 差异检测 | 模型删除字段保存（两段式，删被绑定的 amount）、引用已删字段节点标黄（dashed outline 2 节点） | PASS |

## 修复实证的关键断言

1. **B3-2 fieldRef 落协议字段**：草稿 JSON 中 `"fieldRef":"amount"` 位于 LayoutNode 顶层而非 props。
2. **B4-3 嵌套结构落库**：树结构递归检查 TextInput 在 SectionCard children 内。
3. **B7-3 预览渲染绑定表单**：预览页显示「验收绑定页 / 卡片 / 提 交」——字段元数据 200（修复前 403）。
4. **B8-2 标黄**：删除 amount 字段后重开设计器，引用节点 2 个 dashed outline。

## 修复清单（源码 532775a + 6d8257e）

**前端**：fieldRef 写协议字段（updateProps 命令 + 属性面板读 node.fieldRef）；doSave 统一表达式阻断 + 保存并发保护（savedDoc 引用快照）；画布拖拽接入 validateDropTarget 容器嵌套 + 容器 dragover 落点捕获；大纲上移/下移/删除；新建向导「由模型生成默认布局」；409 弹层三方差异摘要表；DesignerStore 失败命令不污染历史栈 + dirty 保存基线深比较。

**后端**：PageCommandService.snapshotModelRef（发布/回滚快照 modelId 回退 schema.modelId）；PreviewDataGuard.collectPublishedModelId（限页预览放行集补 published 页面 schema 的 modelId——修复字段元数据 403；安全边界未扩大：仍限页绑定模型 ∪ 快照引用）。

**双端表达式契约**：前端求值器补 ===/!== 分支（上一轮只补优先级表、求值炸「未知运算符」的真实缺陷）；Java tokenizer 三字符识别 + 优先级表 + strictEquals；共享向量 11 条严格相等用例（含跨类型不转换 3 条）——前端 99/99、Java 18/18 同判。

## 已知边界与遗留

- 手势级 HTML5 DnD 未直测（fiber 直调合成事件等价链路）；容器嵌套用同框 dragover+drop 序列实证
- 409 差异表为摘要级（节点数/绑定数/表达式数），无字段级三方 diff——01BE 口径符合，粒度登记遗留
- 大纲上移/下移仅验收入口可见性（排序语义由 store 单测 moveWithin 覆盖）
- 验收脚本自身修正多处（B2 流程顺序、antd Select 展开点击、JSON 键序无关断言、保存后 draftVersion 轮询）——不改变产品结论
