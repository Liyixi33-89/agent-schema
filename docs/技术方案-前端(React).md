# 低代码平台前端技术方案（React）

> 版本：v0.3 | 日期：2026-10-28 | 角色：高级前端工程师视角
> 配套文档：《PRD-低代码平台产品规划.md》（v0.3 三级上线门禁已定稿）《技术方案-后端(Java).md》（v0.3）
>
> v0.2 变更：按 PRD §6 决策修订——新增 §3.9 双轨渲染实现、§3.10 L2 脚本运行时、§3.11 用量埋点 SDK；交付形态调整为纯 SaaS + 预留私有化。
> v0.3 变更（对齐 PRD v0.3 服务保障补齐与安全攻防体系，2026-10-28）：
> - §3.10 L2 执行隔离模型修正：废弃「ESM scope + freeze(ctx)」伪隔离，改 **Worker 执行 + 受控消息桥（op 白名单）+ terminate() 硬中断**；token 永不进 Worker；网络出口靠红线扫描 + CSP 双层下发（宿主页面 CSP + Worker 脚本响应头独立 CSP）+ 网关鉴权三层兜底（Worker 不天然禁用 fetch）——实现真源 08FE §3-5
> - §3.11 席位口径对齐三口径定版（授权/活跃/账单）；前端仅活跃漏斗参考
> - §6 分期：P1 补成员建号/首次登录强制改密（PASSWORD_CHANGE_REQUIRED）、预览凭证签发/交换（PRD 06 §2.4 修正）、流程设计器画布只读（flow-service 整体 Phase 2）、服务保障前端触点（租户级健康页/状态页/SLA 看板，支撑 L-Pilot 门禁 G4）；L2 隔离验收（G7）未通过前功能整体关闭（feature flag）

## 1. 技术选型总览

| 领域 | 选型 | 说明 |
|---|---|---|
| 框架 | React 18 + TypeScript | 并发特性(useTransition/Suspense)用于设计器大数据量渲染优化 |
| 构建工具 | Vite | 冷启动快，适合设计器这种大组件库项目 |
| 状态管理 | Zustand（全局） + React Query/TanStack Query（服务端状态） | 设计器内部状态用 Zustand，API 数据缓存/同步用 RQ，职责分离 |
| 表单引擎 | 自研 Schema-Form（基于 react-hook-form 封装） | 需要动态字段、联动、校验与 Schema 协议强绑定，不直接用 formily/antd 的原生方案，而是封装一层抽象 |
| UI 组件库 | Ant Design 5（中后台基座） | 设计器画布内渲染的是"业务组件"，设计器自身 UI（面板/工具栏）用 AntD |
| 可视化搭建 | 自研 Canvas 引擎（基于 @dnd-kit 拖拽 + 自建渲染树） | 不依赖重量级低代码引擎（如 lowcode-engine）以保留定制自由度，但协议设计参考阿里 lowcode-engine 的 Schema 规范 |
| 流程图/审批流设计器 | React Flow (xyflow) | 节点式编排的事实标准库，二次封装节点类型 |
| 图表 | ECharts (echarts-for-react) | 仪表盘组件 |
| 代码编辑器 | Monaco Editor | 逃生舱脚本节点、JSON Schema 调试 |
| 路由 | React Router v6 | 运行时应用的动态路由（基于 Schema 生成路由表） |
| 微前端/应用隔离 | ~~qiankun 或 Module Federation（二期评估）~~ → **决策定版（ADR-FE-001）** | 原选型拆解为两个不同问题分别定版：①**运行时嵌入隔离 = iframe + Web Component**（文档 06FE §5：postMessage 协议 + Shadow DOM，P2 交付）——qiankun 放弃，理由：平台运行时本就是独立产物（设计器/运行时解耦原则），iframe 天然进程级隔离，引入 qiankun 的 JS 沙箱与样式劫持属于为"单页内多技术栈"设计的复杂度，与"宿主嵌入第三方系统"的真实需求不匹配；②**物料热加载 = 注册表 + 动态 import(artifactUrl)**（文档 05FE §3）——不依赖 Module Federation，产物即标准 ES module，加载协议更简单且与轨道 B 编译产物统一；MF 从选型清单移除 |
| 包管理/Monorepo | pnpm workspace + Turborepo | 设计器、运行时、组件库、SDK 拆分为多包 |
| 测试 | Vitest + React Testing Library + Playwright(E2E) | |
| 国际化 | react-i18next（**范围收窄，ADR-FE-002**） | 现阶段设计器/admin-console 自身 UI 仅中文；SDK 留空位（文案外置 + `t(key)` 调用约定先行），不做语言包维护。多语言客户出现再接入——避免为不存在的需求维护翻译文件 |

**关键架构原则**：设计器（Designer）与运行时（Runtime）必须解耦为两个独立产物——设计器产出 Schema JSON，运行时只依赖 Schema + 组件库渲染，不依赖设计器代码。这样可以让运行时包体积最小化、支持独立部署/嵌入第三方系统。

---

## 2. Monorepo 包结构

```
schema-frontend/
├── apps/
│   ├── designer/            # 搭建平台主应用（建模器/页面设计器/流程设计器）
│   ├── runtime/             # 低代码应用运行时容器（渲染已发布的应用）
│   └── admin-console/       # 租户/权限/应用管理后台
├── packages/
│   ├── schema-protocol/     # Schema 协议 TS 类型定义 + 校验（zod） —— 前后端共享契约的前端镜像
│   ├── schema-form/         # 动态表单引擎（核心）
│   ├── schema-renderer/     # Schema → React 组件树 渲染引擎（设计器预览 & 运行时共用）
│   ├── component-materials/ # 物料组件库（基础组件+业务组件，遵循统一物料协议）
│   ├── flow-designer/       # 审批流/逻辑编排设计器（基于 React Flow 封装）
│   ├── data-model-designer/ # ER 建模器
│   ├── request-sdk/         # 统一请求层（基于生成的 OpenAPI client）
│   ├── auth-sdk/            # 登录态/权限判断 SDK（供 runtime 和 designer 共用）
│   └── shared-ui/           # 通用 UI 组件（基于 AntD 二次封装）
└── turbo.json / pnpm-workspace.yaml
```

---

## 3. 核心模块设计

### 3.1 Schema 协议层（`schema-protocol`）—— 全平台地基

前端必须与后端约定一份**唯一的 Schema 协议**（JSON Schema 扩展），作为建模、表单、列表、页面、组件配置的统一描述语言。

```ts
// 简化示例
interface ModelSchema {
  id: string;
  name: string;
  fields: FieldSchema[];
  version: number;
}

interface FieldSchema {
  key: string;
  type: 'string' | 'number' | 'date' | 'enum' | 'relation' | 'file' | ...;
  label: string;
  required?: boolean;
  rules?: ValidationRule[];
  relation?: { targetModel: string; cardinality: '1:1'|'1:n'|'n:n' };
  widget?: WidgetConfig; // 该字段在表单/列表中默认用什么组件渲染
}

interface PageSchema {
  id: string;
  type: 'form' | 'list' | 'dashboard' | 'detail';
  layout: LayoutNode[];      // 组件树（容器+物料实例+props+数据绑定表达式）
  dataSource: DataSourceBinding;
  actions: ActionBinding[];  // 按钮事件 -> 流程/API 绑定
}

interface LayoutNode {
  componentName: string;     // 对应 component-materials 中注册的物料
  props: Record<string, any | ExpressionBinding>;
  children?: LayoutNode[];
}
```

- 用 **zod** 定义运行时校验 schema，保证设计器产出的 JSON 在渲染前做结构校验（防止脏数据导致运行时崩溃）。
- 表达式绑定（`ExpressionBinding`，如 `{{ formData.status === 'approved' }}`）需要一个安全的表达式引擎（禁止 `eval`，使用 `jsonata` 或自研的受限 AST 解释器）。
- 该协议需版本化（`schemaVersion`），配合后端做兼容性升级（旧版本 Schema 渲染时自动走 migration 转换层）。

### 3.2 Schema 渲染引擎（`schema-renderer`）

设计器预览和运行时共用同一渲染核心，避免"设计器看到的和线上跑的不一致"。

```
SchemaRenderer
  ├── NodeResolver      # 根据 componentName 从物料注册表找到组件实现
  ├── ExpressionEngine  # 解析 props 中的表达式绑定，订阅依赖数据变化
  ├── DataSourceContext # 提供 formData / listData / globalContext 给子树
  └── ActionDispatcher  # 处理按钮点击 -> 调用 API / 触发流程 / 本地脚本
```

- 设计器中额外包一层 `DesignModeWrapper`：给每个渲染节点加选中框、拖拽手柄、右键菜单，这层在运行时产物中被 tree-shaking 掉（通过条件编译/两套入口文件）。
- 性能：大型列表/表单渲染需要 `React.memo` + 细粒度订阅（避免一个字段变化导致整棵树重渲染）—— 建议用类似 `valtio`/`jotai` 的原子化状态而非一个大 context，或自建"字段级订阅"的轻量 store。

### 3.3 动态表单引擎（`schema-form`）

- 基于 `react-hook-form` 的 `Controller` 机制封装，每个 `FieldSchema` 映射一个 `Controller + 物料组件`。
- **联动能力**：字段间的显示/隐藏/禁用/选项动态过滤，通过"依赖字段 + 表达式"声明式配置，渲染引擎自动建立依赖订阅关系（类似 formily 的 reaction，但自研以配合我们自己的表达式引擎）。
- **校验**：JSON Schema 自带校验规则 + 自定义正则 + 异步校验（如唯一性校验调接口）统一走 `react-hook-form` 的 resolver。
- **分步/分组表单**：Wizard 容器组件，维护跨步骤的表单状态。

### 3.4 可视化页面设计器（Canvas 引擎）

- 拖拽基于 `@dnd-kit`（比 react-dnd 更现代、支持无障碍、性能更好）。
- 画布内渲染即 `schema-renderer` 的 DesignMode，选中节点后右侧属性面板是**根据物料的 propsSchema 自动生成的表单**（即"用 schema-form 来编辑 Schema 本身"——这是低代码设计器的经典套娃模式，复用度高）。
- 撤销/重做：维护 Schema 的不可变快照栈（`immer` + 简单的 history stack）。
- 多人协同编辑（二期）：~~Yjs CRDT 同步~~ → **决策定版（ADR-FE-003）：乐观锁 + 心跳 + 三方对比**（详细 PRD 08 §2.7、前端文档 04FE §7）。理由：①设计器操作粒度大（拖整块/改属性），CRDT 的字符级合并能力过剩；②悲观编辑锁 + 409 三方对比（本地/服务端/差异面板）交互成本低于冲突自动合并的不可预测性；③CRDT 推 P3 预研，且明确**只协同页面设计器**（建模器/流程设计器仍锁机制——元数据变更风险高）。Yjs 相关依赖在 P3 预研结论前不进入依赖树。

### 3.5 ER 建模器（`data-model-designer`）

- 基于 React Flow 做节点（表）+连线（关系）的可视化编辑。
- 字段编辑走侧边抽屉表单（同样复用 schema-form）。
- 关键交互：**Schema Diff 预览**——保存前展示"本次变更：新增字段X / 删除字段Y（有 N 个页面依赖，需确认）/ 修改属性Z（label/校验/枚举等，类型不可改）"，调用后端影响面分析接口。

### 3.6 流程/审批流设计器（`flow-designer`）

- React Flow 自定义节点类型：开始/审批人/条件分支/并行网关/动作（调API/发消息）/结束。
- 节点属性面板同样复用 schema-form 模式驱动。
- 流程 Schema 独立于页面 Schema，但复用同一套"表达式引擎"做条件分支判断。

### 3.7 运行时容器（`apps/runtime`）

- 基于后端返回的"应用路由表"（哪些 PageSchema 挂载在哪些路径）动态生成 React Router 路由，懒加载对应 Schema JSON（按需请求，不整包下发）。
- 鉴权：路由守卫读取 `auth-sdk` 中的权限信息（菜单权限控制路由可见性，按钮权限控制 ActionDispatcher 是否放行）。
- 多租户/多应用：运行时容器需支持通过 subdomain/path prefix 区分租户上下文，请求头自动带租户标识。
- 嵌入能力：支持以 iframe 或 Web Component 形式嵌入第三方系统（隔离方案见 §1 微前端选型 ADR-FE-001；物料加载统一走注册表动态 import，不再绑定 Module Federation）。

### 3.8 物料组件协议（`component-materials`）

每个物料需要暴露统一的"物料协议"文件，供设计器反射生成属性面板：

```ts
interface MaterialMeta {
  componentName: string;
  category: 'basic' | 'business' | 'layout';
  propsSchema: JSONSchema;      // 驱动属性面板自动生成表单
  defaultProps: Record<string, any>;
  previewImage?: string;
  component: React.ComponentType<any>;
}
```

- 基础组件：Input/Select/DatePicker/Switch/Upload 等（薄封装 AntD）。
- 业务组件：组织架构选择器、地址选择器、富文本、级联数据源选择器——这些是低代码平台的差异化竞争力，需要重点投入。
- 支持第三方/业务方自定义物料接入（遵循 MaterialMeta 协议 + npm 包发布 + 设计器注册中心动态加载），对应 PRD 中的"插件市场"。

### 3.9 双轨渲染实现（PRD §6.2 落地）

前端必须把"动态解析"与"编译产物加载"做成统一入口，对上层页面无感知。

**轨道 A：Schema 动态解析（默认，适用于所有物料协议组件）**

```tsx
// schema-renderer 的核心分派
function NodeRenderer({ node, ctx }: { node: LayoutNode; ctx: RenderCtx }) {
  const material = materialRegistry.get(node.componentName);
  if (!material) return <UnknownWidget name={node.componentName} />;
  const props = resolveProps(node.props, ctx);       // 计算表达式绑定
  const Comp = material.component;                   // 同步组件
  return <Comp {...props} data-node-id={node.id} />;
}
```

- `materialRegistry` 支持异步注册：`component` 字段可以是 `React.lazy(() => import(...))`，用 `Suspense` 包裹（骨架屏 fallback）。
- 注册表按需分片加载：首屏只加载当前页面用到的物料（按 `componentName` 精准 import，不做全量 bundle）。
- **Schema 变更即时生效**：运行时只依赖 `/api/page-schema/{pageId}` 返回的 JSON + 版本号，配合 ETag/If-None-Match 缓存，Schema 更新后下次进入页面即生效，无需发版。

**轨道 B：自定义代码（设计时编译 + 运行时加载产物）**

- 设计态：Monaco 编辑源码 → 保存时提交给后端编译服务（返回 `{ artifactUrl, sourceHash, compileError? }`）；
- 运行时：`const mod = await import(/* @vite-ignore */ artifactUrl)` 加载 ES chunk，产物必须按统一导出约定（`export default function render(ctx)`）实现，由渲染引擎在 `ErrorBoundary` 内挂载。
- **脏编译防护**：编译失败时保留上一版产物继续服务（不允许一次错误提交把线上页面打白），控制台展示编译错误详情 + 回滚到指定版本按钮。
- **缓存与版本**：产物 URL 带 content hash（`artifact-{hash}.js`），可长缓存；Schema 里记录 `contentHash`（build-service 返回字段，2026-10-28 统一命名）以便审计"这个页面跑的是哪版代码"。
- **CSP 约束**：不允许 `unsafe-eval`，所以产物必须是预编译 ES module，不能下发源码字符串在浏览器 `new Function` 执行。

**两轨统一的物料协议**

```ts
interface MaterialMeta {
  componentName: string;
  category: 'basic' | 'business' | 'layout' | 'custom';
  propsSchema: JSONSchema;
  defaultProps: Record<string, any>;
  component: React.ComponentType<any> | (() => Promise<{ default: React.ComponentType<any> }>); // 同步 or 异步
  runtime: 'dynamic' | 'compiled';  // 决定走哪条轨道
}
```

### 3.10 L2 前端脚本运行时（PRD §7.2 落地）

**这是逃生舱在前端的唯一实现点，必须做成"沙箱化的钩子执行器"，而不是暴露任意 JS 环境。**

**执行模型**

```ts
interface ScriptHost {
  run(hook: HookName, script: CompiledScript, ctx: ScriptContext): Promise<HookResult>;
}
```

> ⚠️ **隔离模型修正（2026-10-28 安全评审）**：本节原设计「ESM module scope + `Object.freeze(ctx)`」不成立——模块运行在主线程全局环境，`window`/`document`/`fetch` 均可达，freeze 锁不住原型链。现行定版：**Worker 执行 + 受控消息桥（op 白名单）+ `worker.terminate()` 真硬中断**；token 永不进 Worker（`api.call` 由主线程代理）；网络出口隔离靠红线扫描 + CSP 双层下发（宿主页面 + Worker 脚本响应头独立 CSP）+ 网关鉴权三层兜底（普通 Worker 并不天然禁用 fetch/XHR/WebSocket；不宣称「Worker 无全局对象」——WorkerGlobalScope 始终存在，隔离的是能力面）。实现真源见文档 08FE §3-5。

- 编译期：L2 脚本在**设计态保存时**转译（TS→ES5 降级 + 白名单静态扫描），产出受限的模块，运行时在 Worker 内 `import()` 执行，不 eval。
- 运行期：每个页面挂载一个 `ScriptHost` 实例（Worker 池上限 8，LRU 释放），按生命周期触发钩子；钩子超时（warn 500ms / hard 10s）后者 `terminate()` 真终止（同步死循环可被中断——Promise.race/AbortSignal 做不到）。
- 钩子执行必须包在 `try/catch` 内：脚本报错**不能导致页面白屏**，只记录到控制台与上报（这是客户最不能接受的体验事故）。
- **G7 门禁联动（PRD §5.1）**：L2 隔离验收（08FE §8）未通过前，L2 功能整体关闭上线（feature flag）——不以「客户自担」免责。

**ctx 的受控实现（关键：消息桥代理，替代旧版冻结对象）**

```ts
// Worker 内注入的 ctx 代理：每个方法都是 postMessage 往返，无本地能力（08FE §4.2）
// user/page 为 mount 时一次性注入的静态快照；动态操作全部走主线程 op 白名单桥：
//   form.get/set/getValues/setValues · api.call · ui.toast/confirm/dialog · log
function createWorkerCtx(port: MessagePort): ScriptContext {
  return {
    form: { get, set, getValues, setValues },          // → op 'form.*'（postMessage 往返）
    api: {
      // 只能调平台注册过的 API 名；注册名→接口映射在主线程执行并先做权限校验再走网关
      call: (name: string, params?: any) => call('api.call', [name, params]),
    },
    ui: { toast, confirm, dialog },                    // → op 'ui.*'（confirm/dialog 经确认弹窗代理）
    logger: scopedLogger(port),                         // → op 'log'
    user: undefined /* 静态快照注入：pick(user,['id','roles','dept']) */,
    page: { params, query, mode } /* 同静态快照 */,
  };
}
```

**红线实现手段（不是靠文档约束，靠代码强制）**

| 红线 | 强制手段 |
|---|---|
| 禁止原生 `fetch`/`XHR`/`WebSocket` | 三层兜底：①构建期静态扫描禁标识符（编辑期 Monaco linter + 保存期 AST 扫描，redlines.json 双端同源）；②CSP 双层下发阻断越界请求——宿主页面 CSP（`worker-src 'self'` + `connect-src` 白名单）+ **Worker 脚本响应头 CSP（`connect-src 'none'`，独立下发，不依赖宿主 CSP 传递**——Worker 的 CSP 由其脚本自身响应头控制，不是宿主文档 CSP 的自动继承）；③网关对无凭证请求 401。⚠️ 不假设「Worker 里写 fetch 会报错」——普通 Worker 并不天然禁用网络 API |
| 禁止 DOM 操作 | Worker 环境级缺失（`window`/`document` 为 undefined）+ 静态扫描 `document`/`window`/`querySelector` 双保险 |
| 禁止读其他租户数据 | `ctx.api.call` 走后端鉴权（主线程继承当前用户 perms 后代理转发），前端隔离不可信，必须在服务端拦 |
| 禁止无限循环卡死页面 | 钩子超时 `worker.terminate()` 真硬中断（同步死循环可终止）；表单字段变更钩子节流 50ms；不向 Worker 注入定时器 |

**调试能力（上线前置条件，否则客户不吃这套）**

- 脚本测试台：右侧抽屉内嵌 Monaco + mock ctx（可编辑 mock form values/user/params），点"运行"即时看到日志、返回值、耗时、报错堆栈。
- 脚本执行日志面板：按 hook 分组展示最近 N 次真实执行（耗时/异常/轮转），客户可自服务排查。

### 3.11 用量埋点 SDK（PRD §8.5 落地）

前端是"活跃席位"与"AI 额度消耗"等指标的**第一数据源**，一期只埋点不出账，但事件模型必须一次设计对（补埋历史数据不可回溯）。

> 席位三口径定版（PRD §8.4）：**授权**（持设计能力授权的账号数，配额硬限）/ **活跃**（滚动 30 天有设计器写操作）/ **账单**（P3 出账时冻结定义）——前端 `seat.active` 仅活跃口径漏斗参考，授权判定归服务端 tenant-service（后端 13BE），三口径禁止混用。

```ts
type UsageEvent =
  | { type: 'seat.active'; ts: number; userId: string; surface: 'designer' | 'runtime' }
  | { type: 'ai.invoke'; ts: number; userId: string; tokens: { in: number; out: number }; feature: string }
  | { type: 'automation.trigger'; ts: number; flowId: string; trigger: string };
```

- **采集策略**：批量 + 防抖（如 5s 或满 20 条上报一次），页面隐藏时 `visibilitychange` 立即 flush（`sendBeacon`），避免丢数据。
- **幂等**：`seat.active` 按「用户 + 自然日」去重（后端也做一次去重，前端去重只为省流量，不能作为计费唯一依据）。
- **埋点与业务解耦**：统一 `usage-tracker` 包，业务代码只 `track('event', payload)`，不上报逻辑散落各处。
- **纯 SaaS 前置**：埋点请求走独立 endpoint（`/api/metering/events`），不经过业务网关鉴权链路的限流（否则业务限流会影响计费准确性），但要带轻量签名防伪造。
- **禁止埋敏感数据**：payload 只允许 ID/枚举/数值，不允许表单字段值、文件内容（合规红线，埋点一旦泄露业务数据是灾难）。

---

## 4. 关键技术难点与方案

| 难点 | 方案 |
|---|---|
| 大型 Schema 页面渲染性能 | 虚拟滚动（react-window）、字段级细粒度订阅、组件懒加载、`useTransition` 让拖拽交互优先于渲染 |
| 表达式安全执行 | 禁止 `eval`/`new Function`，自建受限表达式解释器或引入 jsonata 沙箱 |
| 设计器与运行时产物一致性 | 共享 `schema-renderer` 核心，仅通过条件编译区分 DesignMode/RuntimeMode |
| 多人协同编辑冲突 | ~~Yjs CRDT 替代传统锁机制~~ → **乐观锁 + 心跳 + 409 三方对比**（ADR-FE-003，详细 PRD 08 §2.7；CRDT 降为 P3 预研且限页面设计器） |
| Schema 版本兼容 | 渲染前的 migration pipeline，前端维护 `schemaVersion -> transform fn` 映射表 |
| 组件物料热更新 | ~~Module Federation 远程加载物料包~~ → **注册表 + 动态 import(artifactUrl)**（ADR-FE-001 拆解②，文档 05FE §3）：设计器/运行时按需拉取 ES module 产物，不影响主应用发版 |
| 低代码表单与原生校验体验割裂 | 统一走 react-hook-form resolver，保证 UX 与手写表单一致（无感知差异） |
| 双轨渲染产物对齐（动态 vs 编译） | 统一 `MaterialMeta.runtime` 标记 + `NodeRenderer` 单入口分派；编译产物受 `ErrorBoundary` + 保留上一版本兜底 |
| L2 脚本失控拖垮页面 | Worker 隔离 + 钩子超时 `terminate()` 真硬中断 + 异常兜底 + 静态白名单扫描（构建期拒绝 fetch/document）+ 执行日志面板 |
| 已删除字段的渲染兼容（PRD §3.1.1） | 元数据带 `fieldStatus`；渲染层统一在 `resolveProps` 前过滤 DELETED 字段；表达式中引用已删字段显式报错而非静默 undefined |
| 短时凭证安全（预览/嵌入，PRD 06 §2.4） | 预览链接只含 grantId 不含 token（5min 单次可吊销，04BE §A.7）；嵌入宿主传一次性 code 换 token；URL 栏永不出现长期凭证 |

---

## 5. 与后端的契约约定

- **Schema 协议**：前后端共享同一份 JSON Schema 定义（建议用 `zod-to-json-schema` 或 OpenAPI 方式维护唯一真源，前端用 `openapi-typescript` 自动生成类型，避免手写 DTO 产生漂移）。
- **API 风格**：后端自动生成的 CRUD API 遵循统一分页/过滤协议（见后端文档 §5），前端 `request-sdk` 基于此封装通用 `useModelList(modelId, query)` / `useModelDetail` hooks。
- **实时能力**：流程状态变更、协同编辑、审批通知走 WebSocket/SSE，前端需要统一的长连接管理层（断线重连、心跳）。

---

## 6. 分阶段交付建议（对应 PRD v0.3 MVP）

> 上线等级：Phase 1 交付物验收以 **L-Pilot 受控试点门禁**（PRD §5.1 G1-G7）为准，其中前端直接承载 **G7 L2 隔离验收**（08FE §8 测试项）；服务保障前端触点（健康页/升级公告横幅）支撑 **G4 可观测**。

1. **Phase 1**：`schema-protocol` + `schema-renderer`（含轨道 A 动态解析）+ `schema-form` + 基础物料库 + ER 建模器（含影响面确认交互）+ 运行时容器 + **L2 脚本运行时（Worker 隔离 + 钩子 + 测试台，G7 门禁项）** + **用量埋点 SDK（含席位三口径活跃漏斗）** + **成员建号/首次登录强制改密（PASSWORD_CHANGE_REQUIRED 拦截页）** + **预览凭证交换流程（grant 换取 + 只读拦截 + 吊销占位页——PRD 06 §2.4 P1 最小集，06FE §5/04BE §A.7）** + **流程设计器画布只读展示（flow-service 整体 Phase 2——P1 表单动作只触发数据写入与状态流转）** + **服务保障前端最小集（租户级健康页入口 + 维护窗口公告横幅）**
2. **Phase 2**：Canvas 拖拽设计器完整版、**流程设计器完整版（审批执行闭环）**、多人协同（**乐观锁 + 心跳**，ADR-FE-003）、组件市场、**轨道 B 编译产物加载（自定义代码）**、**预览沙箱完整版（数据源切换 mock/真实、「允许真实提交」开关、预览签发/吊销管理 UI）**、L4 连接器配置界面、仪表盘设计器（ECharts，详细 PRD 02 §2.6）、主题品牌定制（详细 PRD 02 §2.10）、**租户注销/恢复工单入口（详细 PRD 11 §2.2/§2.3）**、SLA 可用性看板（内部）、**Web Component 嵌入（与 06FE §5 P2 口径一致）**
3. **Phase 3**：AI 辅助生成（自然语言 → Schema）、L3 脚本调试面板对接、**CRDT 协同预研（限页面设计器，结论前不进依赖树）**（微前端隔离增强/Web Component 已前移 Phase 2——与 06FE §5 P2 口径一致，2026-10-28 修正）

---

## 7. 私有化部署前端预留（对应 PRD §6.3）

一期纯 SaaS，但以下现在就要守，否则后期改动面极大：

- [ ] **零硬编码后端地址**：API base / WebSocket / 埋点 endpoint 全部走运行时配置（`window.__APP_CONFIG__` 或 `/config.json` 拉取）
- [ ] **静态资源相对路径**：产物用相对 publicPath，支持部署在任意子路径（`/schema/app/`）
- [ ] **不依赖 SaaS 专属能力**：CDN、第三方字体、外部埋点 SDK 全部自托管或可关闭
- [ ] **License/租户标识不硬编码在 bundle**：租户信息一律运行时从接口/子域获取
- [ ] **无外部网络请求**（字体、图标库、分析脚本），全部打包或通过可配置地址加载

---

## 8. 工程规范

- Lint: ESLint + Prettier + commitlint，统一提交规范
- 组件文档：Storybook 托管所有物料组件，作为设计器属性面板文档的来源之一
- CI：PR 触发 Vitest + Playwright 关键链路（建模→生成页面→保存→预览）
- 性能基线：设计器画布 1000+ 节点场景下交互延迟 <100ms（需持续性能监控/埋点）
