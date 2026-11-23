---
spec_id: 022-flow-designer-task-loop
status: draft
milestone: M18             # 依赖图 Phase 2「流程引擎」；020 阶段 A（已完成）+ 021 阶段 B（本 spec 前置）
created: 2026-11-20
last_verified_at: null
owner: human-lead
---

# Spec · 完整流程阶段 C：前端编辑与办理闭环

## 1. 背景与目标（为什么做）

- **需求来源**：spec 016 §12「完整流程」阶段推进的最后一环——A 流程只读展示（020 done）→
  B 后端最小执行（021 draft）→ **C 前端编辑与办理闭环**（本 spec）。
- **真源依据**：《详细前端技术文档 10》§2 流程设计器（**阶段 C 主依据**——节点类型系统/保存校验/
  编辑交互）+《详细技术文档 05》§A 接口契约 + **spec 021 已冻结的执行契约**（路由/DTO/错误码）。
  020 冻结的七型协议与三模式审批人是**输入结构真源**；021 的支持节点集（START/END/APPROVAL）
  是**编辑器节点面板的边界**——编辑器不得提供后端不支持节点的创建入口。
- **现状**：flow-designer 仅有只读 `FlowCanvas`（020 交付）；designer「流程」页消费演示 fixture；
  runtime 无待办/已办/办理页面；协议 `TRIGGER_FLOW` 动作绑定已定义但 runtime ActionDispatcher 未消费。
- **不做会怎样**：021 后端链路无前端消费方，闭环停在 curl 冒烟；业务表单与流程发起仍断裂。
- **前置条件**：**021 全部 Acceptance 通过（A1–A12）后方可开工本 spec**——消费接口必须真实存在，
  禁止对着不存在的路由开发。

## 2. 范围声明（做什么/不做什么）

**做**（阶段 C = 前端编辑与办理闭环，六项——2026-11-20 用户裁决原文）：

1. **编辑模式**：在只读画布基础上增加明确的编辑模式，**保留只读组件能力**——
   `FlowCanvas`（020 交付物）零改动零回归；新增 `FlowEditor` 组件（拖拽建节点/连线/删除/
   属性面板，React Flow 可编辑配置只在 Editor 内开启）。
2. **最小节点编辑集**：开始、审批、结束三型节点 + 审批人配置（三模式：USER 用户多选 /
   DEPT_ROLE 角色多选 / INITIATOR_SUPERVISOR 上级 + 可选兜底用户）——与 021 支持节点集一致。
3. **真实定义链路**：designer「流程」页接 `GET/POST /api/flows`、`PUT /{id}/draft`、
   `POST /{id}/publish`、`GET /{id}`（021 §3.1）——**不再用演示数据**（fixture 保留仅作单测样本）；
   保存前端预校验（`validateFlowSchema` + 021 节点集白名单）；409 baseVersion 冲突提示重新加载。
4. **审批中心（runtime）**：待办/已办列表（`GET /api/my/tasks`）、实例详情（节点轨迹 + taskLog
   历史查看，`GET /api/flows/instances/{id}`——复用 020 画布实例着色能力渲染节点状态）、
   办理（同意/拒绝 + 意见必填，`POST /api/tasks/{id}/complete`；403/409/422 错误码逐项 UI 反馈）。
5. **业务表单接通流程发起**：报销登记表单（既有页面零重构）提交成功后按 PageSchema
   `TRIGGER_FLOW` 动作绑定发起实例（`POST /api/flows/{flowId}/instances`，recordId 取提交返回值；
   `INSTANCE_ALREADY_RUNNING` → 明确提示不阻断已保存结果）——**保留原报销登记模式**：
   无 TRIGGER_FLOW 绑定的表单行为完全不变。
6. **浏览器全链路验收**：设计并发布 → 用户提交 → 审批人办理 → 申请人查看结果 → 刷新后状态一致
   （CDP 浏览器链路，同 spec 016/018 先例；双账号：申请人 + 审批人）。

**不做**（推迟去向逐条写明）：

- 多级审批编辑（审批节点仅可加一个）、条件分支/并行网关/CC 节点编辑 → 后端 021 支持集扩展后
  的后续 spec（编辑器节点面板按支持集白名单渲染，协议七型其余四型不可创建）；
- 模拟运行接口（05BE `/simulate`）与前端图推演（10FE §2.3）→ 发布前模拟提示属全量形态，
  本期发布仅跑结构校验 + 后端发布校验链；
- 转办/撤回/催办/加签 UI（021 未提供对应路由；transfer 契约占位 501）→ 后续 spec；
- ApprovalTimeline 独立物料 → 本期实例详情用列表式轨迹渲染（节点状态 + taskLog 时间线），
  物料化抽象随审批中心全量形态再做；
- 流程定义版本历史/回滚 UI、停用操作 → 后续（021 未提供）;
- WS 待办推送（05BE 前端对接要点——React Query 失效刷新）→ 本期手动刷新 + 办理后失效重拉，
  长连接随通知通道扩展。

## 3. 接口契约（对外的稳定承诺）

### 3.1 flow-designer 包新增导出（编辑面）

```ts
// packages/flow-designer/src/index.tsx 追加（FlowCanvas 只读红线不动）
export type EditorAction =
  | { kind: 'ADD_NODE'; nodeType: 'START' | 'APPROVAL' | 'END' }
  | { kind: 'CONNECT'; from: string; to: string }
  | { kind: 'DELETE_NODE'; nodeId: string }
  | { kind: 'SET_APPROVER'; nodeId: string; approver: ApproverRule }
  | { kind: 'SET_NAME'; nodeId: string; name: string };

export function FlowEditor({ schema, onChange, onValidate }: {
  schema: FlowSchema;
  onChange: (next: FlowSchema) => void;      // 受控——schema 变更唯一出口
  onValidate?: (errors: string[]) => void;   // 实时校验反馈（validateFlowSchema 结果指针）
}): React.ReactElement;
/** 编辑约束内置于组件：节点面板只暴露三型；START 唯一不可删（同 020 校验规则前置到交互层）；
    连线方向约束（END 无出边/START 无入边）；非法操作不产生 onChange。 */
```

- 复用 020 `toCanvasGraph`/`layeredFlowLayout`；属性面板（审批人三模式配置）为 Editor 内部
  子组件，数据源：`GET /api/org/users?keyword=`、角色列表（03BE §A.3，消费方视角）。

### 3.2 designer「流程」页改造（020 §3.3 升级）

```
列表态：GET /api/flows?appId= 真实数据（loading/空态/错误重试）；操作：新建（弹窗填 name/flowKey）
        → POST /api/flows；查看（只读画布，020 能力保留）；编辑（进 FlowEditor 态）
编辑态：FlowEditor + 工具栏（保存草稿 PUT /{id}/draft {flowSchema, baseVersion} →
        409 {serverVersion} → 提示刷新重载；发布 POST /{id}/publish →
        422 NODE_TYPE_NOT_SUPPORTED 等校验错逐节点定位展示；成功 → 版本号更新 + 状态 PUBLISHED）
保存前端预校验：validateFlowSchema 不过 → 禁用保存/发布按钮 + 错误面板（020 同款交互）
演示标注：DEMO_FLOWS 不再进列表；fixture 文件保留供单测
```

### 3.3 runtime 审批中心（消费 021 §3.2 路由）

```
路由（AppShell 内新增，会话守卫同既有页面）：
  /approval/todo    待办列表（status=TODO）—— 行点击 → 办理抽屉
  /approval/done    已办列表（status=DONE）
  /approval/instance/:id  实例详情——020 FlowCanvas + instanceState 着色（PENDING/ACTIVE/DONE/SKIPPED）
                          + taskLog 时间线列表 + 业务记录摘要（bizTitle/model/record 链接）
办理抽屉：同意/拒绝 Radio + 意见 TextArea（必填）→ POST /api/tasks/{id}/complete
  → 成功：失效待办查询重拉 + 结果提示；失败按错误码反馈：
     403 TASK_NOT_ASSIGNED → 无权限提示；409 TASK_ALREADY_COMPLETED → 已被办理提示 + 重拉；
     422 COMMENT_REQUIRED → 表单校验锚点
提交人入口：报销列表/详情页显示流程状态（flow_status 字段）+ 「查看流程」进实例详情
```

### 3.4 TRIGGER_FLOW 动作消费（runtime ActionDispatcher 新增）

```ts
// 协议既有绑定：{ type: 'TRIGGER_FLOW'; flowId: string; bizKeyFrom: string }（types.ts 已冻结）
// FormPageHost 提交成功后动作链追加执行：
async function triggerFlow(flowId: string, recordId: string): Promise<void> {
  // POST /api/flows/{flowId}/instances { modelId: page.modelId, recordId }
  // 409 INSTANCE_ALREADY_RUNNING → Toast「该记录已有进行中流程」（不影响已保存的表单结果）
  // 409 FLOW_DEF_NOT_PUBLISHED → Toast「流程未发布」（设计态误配提示）
}
// bizKeyFrom 语义登记：本期固定取提交返回的 recordId（协议字段保留，表达式求值属后续）
// 无 TRIGGER_FLOW 绑定的表单：行为与现状逐字节一致（回归红线）
```

## 4. Tasks（任务清单，执行时逐项勾选）

- [ ] T1 flow-designer：`FlowEditor` 受控组件（三型节点面板/连线/删除/审批人三模式属性面板/
      实时校验回调）+ 编辑约束单测（START 唯一/END 无出边/非法操作不触发 onChange）。
- [ ] T2 designer「流程」页：真实接口列表/新建/查看（020 只读保留）/编辑态（保存草稿 409 冲突/
      发布 422 逐节点错误/成功版本更新）；演示 fixture 退出列表。
- [ ] T3 runtime 审批中心：待办/已办页 + 实例详情（FlowCanvas 实例着色 + taskLog 时间线）+
      办理抽屉（错误码逐项反馈）。
- [ ] T4 runtime ActionDispatcher：TRIGGER_FLOW 消费（提交后发起/错误提示矩阵）+
      无绑定表单零行为回归测试。
- [ ] T5 报销试点接线：报销登记页 PageSchema 追加 TRIGGER_FLOW 绑定（试点流程 defId 配置）；
      报销列表/详情显示 flow_status + 实例详情入口。
- [ ] T6 浏览器全链路验收（CDP）：设计并发布 → 用户提交 → 审批人办理 → 申请人查看结果 →
      刷新后状态一致（双账号，§5 A6 场景脚本）。
- [ ] T7 回归与文档：全量前端测试 + 架构巡航 + verify.ps1；10FE §2 差异登记表更新
      （阶段 C 落地项打钩）；020 沉淀「阶段 B/C 前置」口径核对。

## 5. Acceptance（验收标准，可测试）

- [ ] A1 `verify -Level commit` 通过（前端全量测试 + 构建 + 架构巡航零违规）。
- [ ] A2 FlowEditor 三型节点可建/可连/可删，审批人三模式配置完整落进 FlowSchema；
      保存预校验不过时按钮禁用 + 错误面板（单测断言）。
- [ ] A3 designer 流程页：新建 → 编辑 → 保存草稿 → 发布 → 列表状态/版本更新全链路可用；
      409 冲突与 422 校验错均有明确 UI 反馈（单测 + 人工）。
- [ ] A4 只读组件零回归：FlowCanvas 既有测试（020 交付的 12 个）全绿，props 签名未变。
- [ ] A5 审批中心：待办/已办分页正确、实例详情节点着色与 taskLog 时间线渲染、
      办理成功后列表失效重拉（单测 + 人工）。
- [ ] A6 **浏览器全链路（裁决原文）**：设计并发布 → 用户提交 → 审批人办理 → 申请人查看结果 →
      刷新后状态一致——CDP 脚本双账号（申请人提交报销/审批人待办办理同意/申请人侧实例 FINISHED
      + flow_status=通过；拒绝分支同链路复跑断言驳回态）；刷新前后页面状态与服务端一致。
- [ ] A7 TRIGGER_FLOW 错误矩阵：INSTANCE_ALREADY_RUNNING / FLOW_DEF_NOT_PUBLISHED 提示正确；
      无绑定表单提交行为与改造前一致（回归断言）。
- [ ] A8 越权路径：审批人 B 查看他人待办详情被后端拒（403/404）时 UI 不白屏（错误态渲染）。

## 6. 验证步骤（人可复跑）

```text
1. pnpm --filter @schema/flow-designer test && pnpm --filter @schema/schema-protocol test
2. powershell -File scripts\verify.ps1
3. 浏览器链路（线上验收环境，双账号）：
   designer：新建流程 → 编辑（START→APPROVAL→END + 审批人=审批账号）→ 发布
   runtime ：申请人提交报销 → 自动发起实例；审批人 /approval/todo 办理同意
   申请人侧：列表 flow_status=通过 → 实例详情节点全 DONE；刷新后一致
4. 负例：重复提交同记录（INSTANCE_ALREADY_RUNNING 提示）、未发布流程绑定（409 提示）、
   非审批人办理（403 提示）
```

## 7. 沉淀记录（结项时回填）

- <待结项回填：FlowEditor 受控模式坑 / React Flow 编辑配置与只读复用边界 / CDP 双账号脚本模式>

## 8. 开工契约校准（2026-11-20 评审定版）

- **前置门**：021 A1–A12 全过方可开工；开工前以 021 实际冻结的路由/DTO/错误码复核本 spec §3.2–3.4，
  若 021 实现与草案有收窄（如字段更名），以 021 代码为准并在本节登记差异。
- **编辑边界真源**：节点面板白名单 = 021 支持节点集（三型）——协议七型其余四型不可创建；
  后续扩节点必须 021 支持集先行，编辑器跟随，禁止「协议有定义即上编辑入口」。
- **只读能力保留红线**：FlowCanvas 及其测试为 020 冻结交付物，本 spec 只增不改；
  实例着色走既有 `instanceState` 通道（020 §3.2 已预留）。
- **报销模式保留红线**：报销登记表单结构/提交流程不变，TRIGGER_FLOW 是动作链追加项；
  无绑定页面逐字节回归（A7）。
- **授权范围（需人类负责人确认）**：① runtime 新增 /approval/* 路由与页面（AppShell 导航项）；
  ② 报销登记 PageSchema 数据变更（追加 TRIGGER_FLOW 绑定——设计数据非代码）；
  ③ CDP 双账号验收脚本（验收环境测试账号复用 016/018 先例）。
