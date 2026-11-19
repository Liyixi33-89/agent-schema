---
spec_id: 017-chart-minimal-loop
status: draft
milestone: M17              # 依赖图 §5 Phase 2「仪表盘设计器」；承接 spec 016 §12 图表最小闭环决议
created: 2026-11-18
last_verified_at: null
owner: human-lead
---

# Spec · 图表最小闭环（指标卡/柱状图/折线图）

## 1. 背景与目标（为什么做）

- **需求来源**：spec 016 §12 A 表「图表/仪表盘」——产品能力缺口，裁决为**后续规划（优先级最高——先启动）**；
  真源设计文档《详细前端技术文档 12 · 仪表盘设计器与图表物料》（12FE）与《详细PRD 02》§2.6（仪表盘设计器 P2）。
- **现状**：协议已冻结 `PageType: DASHBOARD`、`DataSourceType: MODEL_AGG`、`DataSourceBinding.aggregate`
  （AggregateRequest：measures ≤5/group topN ≤50/timeBucket）；后端聚合引擎已上线
  （`POST /api/data/{modelId}/aggregate`，护栏：度量 1-5、桶数 ≤1000、超时 10s、时间桶须 filter 双边范围）；
  但前端 `chart-kit` 为空壳（`export {}`）、运行时 DASHBOARD 页显式报「暂未支持」、设计器只能新建 FORM 页。
- **不做会怎样**：DASHBOARD 页面类型协议空转——用户建不出仪表盘，模型数据无法以图表消费，
  「设计-发布-运行」链上仪表盘是断点。

## 2. 范围声明（做什么/不做什么）

**做**（最小闭环 = 12FE 全链的最小子集）：

1. `chart-kit`：ECharts 按需引入封装（LineChart/BarChart 受控组件 + 数值卡），
   统一 loading/empty/error 三态（Card 包裹，error 不白屏）。
2. 图表物料注册：`component-materials` 增加 `MetricCard`、`BarChart`、`LineChart` 三物料（group「图表」）。
3. 运行时 DASHBOARD 宿主：`DashboardPageHost` 消费 `page.layout`（沿用 SchemaRenderer 物料轨道），
   数据装载按节点 props 内 `dataSource`（AggregateRequest 形态）调用 `client.aggregate`。
4. 设计器：新建页面可选类型 DASHBOARD；图表物料入面板；属性面板支持图表数据源配置
   （模型 + measures + group/timeBucket 字段下拉——复用既有 widget 类型，不新增控件）。
5. 发布兼容：PageSchema 结构不变（图表配置存于 `LayoutNode.props`，JSON Schema 已允许任意静态 JSON props）；
   后端 `FieldRefScanner` 已扫描 props 递归结构与 aggregate 字段（引用面自动登记，无需后端改动）。

**不做**（推迟到后续阶段，逐条写明去向）：

- 饼图/表格卡物料（12FE 五物料中的另两个）→ 后续按需补，本 spec 只交付指标卡/柱状/折线；
- 图表联动 `chartLink`（12FE §5）→ Phase 2 完整版；
- 24 列栅格画布独立模式（12FE §6）→ 本期 DASHBOARD 页沿用现有页面设计器 Canvas（非顶层两层嵌套强约束）；
- 模型列表/静态 JSON 数据源（12FE §4 ②③）→ 只做聚合主路径；
- 同比环比、图表导出图片（12FE P3 项）→ 不做；
- 视口惰性实例化/性能 CI 门禁（12FE §7/§8）→ 性能基准随完整版补；
- 时间桶自动补范围（后端要求 filter 双边范围——设计器配置 timeBucket 时提示须配范围，不自动注入）。

## 3. 接口契约（对外的稳定承诺）

### 3.1 物料协议（新增 3 个 componentName，注册进既有 MaterialRegistry）

```ts
// component-materials 注册（MaterialMeta.runtime='dynamic'）
'MetricCard'  // 指标卡：props { title?: string; value?: number; unit?: string; dataSource?: ChartDs }
'BarChart'    // 柱状图：props { title?: string; dataSource?: ChartDs }
'LineChart'   // 折线图：props { title?: string; dataSource?: ChartDs }

// 图表数据源（存于节点 props——协议 LayoutNode.props 已允许静态 JSON 对象）
interface ChartDs {
  modelId: string;
  aggregate: {
    measures: { fieldKey: string; func: 'SUM'|'AVG'|'COUNT'|'COUNT_DISTINCT'|'MAX'|'MIN' }[];
    group?: { fieldKey: string; topN?: number };
    timeBucket?: { fieldKey: string; interval: 'DAY'|'WEEK'|'MONTH' };
  };
  filter?: FilterNode;   // 时间桶场景须含桶字段双边范围（后端护栏）
}
```

- `ChartDs` 是 `DataSourceBinding.aggregate` 的**复用**而非新造：形态与冻结契约一一对应；
  不新增协议枚举、不改 `schemaVersion`（props 静态 JSON 已在协议合法面内）。

### 3.2 运行时数据装载（RequestClient 扩展）

```ts
// request.ts：对齐后端 AggregateBuilder.parseRequest 请求体（groupField/groupTopN/bucketField/bucketInterval）
client.aggregate(modelId, body): Promise<{ rows: AggRow[] }>
// AggRow = { bucket?: string; dimension?: unknown; values: { func: string; fieldKey: string; value: number|null }[] }
```

### 3.3 宿主分派（FormPageHost 扩展）

- `page.type === 'DASHBOARD'` 分支由「暂未支持 Alert」替换为 `<DashboardPageHost client page fields />`；
- DASHBOARD 页 `modelId` 可空（PRD 02 §2.6「仪表盘可不选模型」）——装载逻辑放行 `!page.modelId`（仅 FORM/DETAIL 强制）；
- 每图表节点独立装载：无 dataSource → 设计态占位文案；装载失败 → Card 内 Alert（不白屏）。

### 3.4 设计器

- 新建页面向导加 `type: 'DASHBOARD'` 选项（模型可选）；
- 面板物料分组新增「图表」（3 物料 propsSchema：title 文本 + dataSource 配置组）；
- 属性面板 `fieldRef` widget 复用于 measures/group/timeBucket 字段下拉（值取页面模型 ACTIVE 字段）。

### 3.5 发布与兼容策略

- 无 schemaVersion 升级：新物料名对旧运行时走 `__UnknownWidget__` 兜底（不崩溃）；
- 发布校验链零改动：PageSchema 结构校验（前端 validate.ts / 后端 PageSchemaValidator）对 props 静态 JSON 均放行，
  字段引用扫描已覆盖 props 递归 + aggregate（FieldRefScanner 位置 2 递归）——**引用面天然登记，无需后端发版**。

## 4. Tasks（任务清单，执行时逐项勾选）

- [ ] T1 `chart-kit` 实现：ECharts 按需引入（echarts/core + LineChart/BarChart + GridComponent/TooltipComponent），
      受控 option 更新（setOption notMerge=false）、卸载 dispose、resize 归并（ResizeObserver + rAF）；
      数值卡不依赖 echarts（纯 AntD Statistic）
- [ ] T2 `component-materials`：三物料注册（含 MetricCard 直渲、Bar/Line 经 chart-kit）；
      `defaultWidgetFor` 不动（图表不按字段类型默认推断）
- [ ] T3 `request.ts`：`aggregate` 方法（请求体字段名对齐后端 parseRequest：groupField/groupTopN/bucketField/bucketInterval）
- [ ] T4 `DashboardPageHost.tsx`：layout 渲染（SchemaRenderer 轨道）+ 每节点数据装载 + 三态
- [ ] T5 `FormPageHost.tsx`：DASHBOARD 分支替换 + `!page.modelId` 对 DASHBOARD 放行
- [ ] T6 设计器：新建页面类型选项 + 面板「图表」分组 + 图表 propsSchema（dataSource 配置组）
- [ ] T7 测试：chart-kit option 映射/三态单测；DashboardPageHost 装载/错误分支测试；
      MetricCard 数据源映射测试（rows→value）
- [ ] T8 验证：`pnpm --filter @schema/runtime test` + `verify.ps1`（frontend-build/frontend-test 全绿）

## 5. Acceptance（验收标准，可测试）

- [ ] A1 `verify -Level commit` 通过（frontend-tsc/build/test 全绿）
- [ ] A2 设计器可创建 DASHBOARD 页 → 拖入柱状图 → 配置模型+measures+group → 保存草稿成功
- [ ] A3 发布后运行时打开该页：柱状图渲染真实聚合数据（dimension/values 映射正确）
- [ ] A4 图表节点 dataSource 缺失/聚合请求失败 → Card 内错误占位，页面不白屏
- [ ] A5 MetricCard 无分组单度量聚合 → 数值正确显示
- [ ] A6 旧页面（FORM/LIST）行为不变——现有 335 前端测试全绿即证
- [ ] A7 echarts 按需引入断言：`import * as echarts from 'echarts'`（全量）不得出现在 chart-kit

## 6. 验证步骤（人可复跑）

```text
1. pnpm --filter @schema/chart-kit run build && pnpm --filter @schema/component-materials run build
2. pnpm --filter @schema/runtime run build && pnpm --filter @schema/runtime test
3. powershell -File scripts\verify.ps1   # 七步门禁
4. 手工链路：设计器建 DASHBOARD 页 → 拖 BarChart → 配数据源 → 预览/发布 → 运行时验证渲染与错误态
```

## 7. 沉淀记录（结项时回填）

- （待回填）

## 8. 实现基线接续

本规格 §1 的空壳状态是立项时历史基线，不代表当前代码。图表初版已存在；018 为唯一验收收口入口，禁止二次实现。实现存在不直接勾验收，需引用被测版本与实际结果。ChartDs.aggregate 类型直接复用冻结 AggregateRequest；跨模型字段引用与发布快照须真实测试，不由 props 可存 JSON 推断。旧页面行为须补关键浏览器回归，命令以实际 package scripts 为准。
