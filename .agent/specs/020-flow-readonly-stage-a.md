---
spec_id: 020-flow-readonly-stage-a
status: draft
milestone: M18             # 依赖图 Phase 2「流程引擎」（05BE/10FE 分期声明）；spec 016 §12「完整流程」阶段 A
created: 2026-11-18
last_verified_at: null
owner: human-lead
---

# Spec · 完整流程阶段 A：流程只读展示

## 1. 背景与目标（为什么做）

- **需求来源**：spec 016 §12 A 表「完整流程」裁决——阶段推进：**A 流程只读展示**
  （FlowSchema 契约 + flow-designer 渲染 + 未知节点报错）→ B 后端最小执行 → C 前端设计办理。
  本 spec 只覆盖阶段 A；试点业务=报销审批扩展（保留既有报销登记），但阶段 A 不涉及业务接线。
- **真源设计**：《详细前端技术文档 10 §2》（10FE——FlowSchema 显式 TS 定义/节点类型系统/保存校验/模拟运行）、
  《详细技术文档 05》（05BE——Transpiler 映射/Flowable 集成/接口契约 A.1/A.2）。
- **现状**：`flow-designer` 占位包空壳（`export {}`）；协议层（schema-protocol）无 FlowSchema 类型；
  05BE 分期声明明确「P1 流程画布只读展示，无保存/发布」——本阶段正是该声明的兑现。
- **不做会怎样**：FlowSchema 契约仍只存在于文档（评审稿 §6.1 行动项补的显式 TS 结构无代码真源），
  阶段 B/C 无法开工（执行链的前提是定义可渲染、契约可校验）。

## 2. 范围声明（做什么/不做什么）

**做**（阶段 A = 只读展示，兑现「流程画布 C 裁决」）：

1. **FlowSchema 契约冻结进协议层**：10FE §2.1 显式 TS 定义（`FlowSchema/FlowNode/FlowEdge/ApproverRule`）
   进 `schema-protocol`（类型 + 常量 + `validateFlowSchema` 结构校验——连通性/网关配对/悬空节点，
   与 PageSchema 校验器同层）；**不加 schemaVersion 迁移**（阶段 A 无存量数据，首版即 v1）。
2. **flow-designer 只读画布**：React Flow（复用 ER 画布同款依赖与封装模式）渲染 FlowSchema：
   - 节点=FlowNode 按类型着色/图标（start/approver/condition/parallelGateway/action/connector/end）；
   - 边=FlowEdge（conditionExpr 有值时虚线+标签）；
   - 布局=BFS 分层（复用 data-model-designer `layeredLayout` 同构逻辑或直接引包）；
   - **未知节点类型 → 明确报错**（渲染层 `__UnknownNode__` 占位 + 错误提示，不白屏——裁决原文）。
3. **定义加载**：`GET /api/flows?appId=` 列表 + `GET /api/flows/{id}` 详情（05BE A.1——若后端未上线该路由，
   阶段 A 前端以**契约 Mock 消费**：接口客户端方法 + 本地 fixture 演示页；后端路由随阶段 B 落地）。
   ⚠️ 后端核对项：05BE 是 Phase 2 设计，flow-service 无实现——**阶段 A 后端零改动**，前端消费面按契约先行。
4. **designer 入口**：应用导航加「流程」只读页（列表 + 画布查看）；无保存/发布/编辑入口（分期红线）。
5. **运行状态展示（最小）**：实例详情聚合契约（05BE A.2 `GET /api/flows/instances/{instanceId}`）的
   `nodes[].state` 高亮——阶段 A 仅做**契约类型定义 + 画布状态着色能力**，无真实实例数据（阶段 B 前无实例）。

**不做**（推迟去向逐条写明）：

- 流程编辑（拖拽建节点/连线/属性面板）→ 阶段 C「最小编辑：开始→审批→结束」；
- 保存/发布/模拟运行接口调用 → 阶段 B/C（P1 分期红线——05BE/10FE 头部声明）；
- Transpiler/BPMN/Flowable 任何后端实现 → 阶段 B；
- 审批人规则解析、条件表达式求值 → 阶段 B（前端只渲染配置形态，不求值）；
- ApprovalTimeline 物料、待办/已办列表 → 阶段 B（依赖实例数据）；
- 并行网关配对交互编辑、ConnectorNode 参数面板 → 阶段 C 及以后。

## 3. 接口契约（对外的稳定承诺）

### 3.1 schema-protocol 新增（契约冻结——阶段 B/C 的公共前提）

```ts
// types.ts 追加（FlowSchema 首版 v1——无迁移）
export const FLOW_NODE_TYPES = ['start', 'approver', 'condition', 'parallelGatewaySplit',
  'parallelGatewayJoin', 'action', 'connector', 'end'] as const;
export interface FlowSchema {
  id: string; flowKey: string; name: string; appId: string; bindModelId?: string;
  nodes: FlowNode[]; edges: FlowEdge[]; schemaVersion: number;
}
export type FlowNode = /* 10FE §2.1 七型联合——与后端 Transpiler 映射表一一对应 */ ...;
export interface FlowEdge { id: string; source: string; target: string; label?: string; conditionExpr?: ExpressionBinding }
export type ApproverRule = /* 六种规则联合（ROLE/DEPT_HEAD/SUPERIOR/FIELD_VALUE/EXPR + 后端三策略留阶段 B） */ ...;

// validate.ts 追加
export function validateFlowSchema(v: unknown): { ok: true; value: FlowSchema } | { ok: false; errors: string[] };
// 校验：结构完整性 + 连通性（start 可达 end、无悬空节点）+ 网关配对（split/join pairId 对应）
```

### 3.2 flow-designer 包导出（渲染面——React 受控组件）

```ts
// packages/flow-designer/src/index.tsx（react peer——同 chart-kit 模式：包内零 react 运行时依赖红线不适用于组件包，
//  按 component-materials 先例：peerDependencies react + 注入式渲染可选）
export function FlowCanvas({ schema, instanceState?, onSelect? }: {
  schema: FlowSchema;
  /** 实例状态高亮（阶段 B 数据——节点 state: PENDING|ACTIVE|DONE|SKIPPED 着色） */
  instanceState?: { nodes: { nodeId: string; state: string }[] };
  onSelect?: (nodeId: string) => void;
}): React.ReactElement;
export function layeredFlowLayout(nodes: FlowNode[], edges: FlowEdge[]): Record<string, { x: number; y: number }>;
```

- 未知节点类型渲染 `__UnknownNode__` 红色占位节点 + 顶部 Alert「发现未知节点类型 N 处」（不白屏）。

### 3.3 designer 接线

- 应用导航「流程」页（只读）：列表（契约 Mock 或后端上线后真实数据）→ 点击进画布查看；
- 无编辑/保存/发布按钮（分期红线 UI 呈现）。

### 3.4 发布与兼容

- 前端独立发布：协议新增类型不破坏既有面（纯增量导出）；后端零改动；
- 阶段 B 开工时 FlowSchema 已冻结——后端 Transpiler 按此结构实现（契约先行）。

## 4. Tasks（任务清单，执行时逐项勾选）

- [ ] T1 schema-protocol：FLOW_NODE_TYPES/FlowSchema/FlowNode/FlowEdge/ApproverRule 类型 +
      validateFlowSchema（结构/连通性/网关配对）+ 单测（合法 fixture 过 / 悬空节点拒 / 网关不配对拒 / 未知 type 拒）
- [ ] T2 flow-designer 包：FlowCanvas 只读渲染（七型节点卡 + conditionExpr 边样式 + 未知节点占位报错）
      + layeredFlowLayout 分层布局 + 单测（渲染快照/未知节点不抛异常）
- [ ] T3 designer：「流程」只读页（列表 + 画布）+ 契约 Mock fixture（演示用合法 FlowSchema 样例）
- [ ] T4 测试：协议校验负样本（三阻断）+ 画布渲染分支；全量回归零破坏
- [ ] T5 验证：全量 test + verify.ps1；10FE §2 文档核对（FlowSchema 代码真源与文档定义一致——
      文档对齐项随本 spec 完成）
- [ ] T6 阶段 B 前置登记：05BE 接口契约（A.1/A.2）消费面类型定义是否随阶段 A 提前入 protocol
      （决策：不提前——接口 DTO 随阶段 B 后端实现冻结，避免双端空转）

## 5. Acceptance（验收标准，可测试）

- [ ] A1 `verify -Level commit` 通过
- [ ] A2 合法 FlowSchema fixture 在只读画布完整渲染（七型节点全部可见、边正确连接）
- [ ] A3 未知节点类型 → 占位节点 + Alert 报错，画布不白屏不抛异常（单测断言）
- [ ] A4 悬空节点/网关不配对/缺 start-end 连通的 Schema 被 validateFlowSchema 拒绝（单测断言）
- [ ] A5 designer「流程」页可打开并查看示例流程（人工链路）；无任何编辑/保存入口（UI 断言）
- [ ] A6 既有页面设计/ER 建模功能零回归（全量测试绿即证）
- [ ] A7 协议包零新增依赖（schema-protocol 依赖数仍为 0——架构巡航红线）

## 6. 验证步骤（人可复跑）

```text
1. pnpm --filter @schema/schema-protocol test && pnpm --filter @schema/flow-designer run build
2. powershell -File scripts\verify.ps1
3. 人工链路：designer 打开应用 → 导航「流程」→ 列表进画布 → 七型节点查看
   → 构造含未知类型的 fixture → 占位报错可见
```

## 7. 沉淀记录（结项时回填）

- （待回填）

## 8. 开工契约校准

- 本阶段仅显式演示 fixture，不对不存在的接口发请求或在 403/404 后回落假数据；界面标明演示、非真实实例。
- FlowNode/ApproverRule 不保留省略定义，按 10FE 真源完整落地；枚举数量以代码常量为准。真实接口 DTO 留阶段 B。
- 实例高亮只定义封闭状态枚举与查看器输入，不声称实例服务已实现。
- 校验 ID 唯一、端点存在、start/end 入出度、全节点从 start 可达且能到 end、split/join 配对；首版不允许环，布局须有循环保护。
- 严格校验器拒绝未知类型；查看器对不合法输入容错显示未知节点并报告，不让校验失败导致白屏。
- 禁止拖动节点、连线、删除及键盘修改，仅允许选择、平移与缩放。既有 ER/页面关键浏览器链路需回归，不能仅以单测全绿证明 UI 不变。
