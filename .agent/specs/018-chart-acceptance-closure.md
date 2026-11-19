---
spec_id: 018-chart-acceptance-closure
status: draft
milestone: M17             # 依赖图 §5 Phase 2「仪表盘设计器」；承接 spec 017 已落地实现与 §16 §12 图表裁决
created: 2026-11-18
last_verified_at: null
owner: human-lead
---

# Spec · 图表最小闭环验收收口（spec 017 后续）

## 1. 背景与目标（为什么做）

- **需求来源**：spec 016 §12 A 表「图表/仪表盘」裁决——最小闭环（指标卡/柱状图/折线图）优先启动；
  spec 017 已按该裁决落地实现（chart-kit 三图表 / DashboardPageHost / 设计器绑定面板 / request.aggregate），
  但 **spec 017 的 8 项任务与 7 项验收全部处于未勾选状态**，且人工链路验证（A2/A3 手工链路）未执行过。
- **本 spec 定位**：不是二次实现——是 spec 017 的**验收收口与缺口补齐**：
  对照裁决原文逐条核对已实现面，识别真实缺口，补齐后完成 A1-A7 验收闭环。
- **不做会怎样**：spec 017 悬空（draft 永不 done），「设计-发布-运行」链上仪表盘的
  端到端正确性未经验证，后续图表功能（饼图/联动/栅格）建立在未验收基线上。

## 2. 范围声明（做什么/不做什么）

**做**（缺口核对结论先行——T 项按核对结果勾选或补做）：

1. **契约核对**（对照裁决原文逐条）：
   - 冻结绑定契约复用 `DataSourceBinding.aggregate` —— 已核对：`ChartDs` 与冻结 `AggregateRequest`
     一一对应（measures ≤5 / group topN / timeBucket），未新增协议枚举，✅ 符合；
   - chart-kit 适配层统一加载/空/错态 —— 已实现 `ChartShell` 三态（loading→Spin / error→Alert / empty→Empty）✅；
   - 渲染接口与图表库隔离 —— 已实现（物料经 chart-kit 收口，不直接 import echarts）✅；
   - 图表物料注册配置化 —— 已实现（title/dataSource 经属性面板，非静态数组）✅；
   - DASHBOARD 宿主消费 page.layout —— 已实现（collectChartNodes + SchemaRenderer 轨道）✅；
   - 「支持重试和请求取消」—— **缺口①**：宿主无重试入口、请求无 AbortController 取消；
   - 「设计器可配置、预览」—— **缺口②**：设计器画布内图表为设计态占位（宿主不注入 rows），
     无「预览真实数据」能力——裁决要求的「预览」按 12FE §4 即设计态采样预览，最小版本可降级为
     发布前预览页验证，本 spec 明确取舍（见 T3）。
2. **缺口补齐**（本 spec 的净新增）：
   - 请求取消：`request.ts` 的 `aggregate` 增加 AbortSignal 透传（fetch signal）；
     DashboardPageHost 页面切换/节点重装载时 abort 在途请求（消除「旧请求返回串新页数据」）；
   - 失败重试：图表 Card 错误态增加「重试」按钮（按节点重发聚合请求——不做自动重试）；
   - 设计器预览：沿用既有「预览」按钮链路（openPreview 打开运行时预览页）——图表节点在预览页
     走真实聚合装载；设计器画布内维持设计态占位（12FE §4 采样预览属完整版，本期不做）。
3. **验收执行**：spec 017 A1-A7 逐条验证并勾选；本 spec A2 覆盖取消、A3 覆盖重试，A8 覆盖时间桶错误。

**不做**（沿用 spec 017 §2 不做清单，追加）：

- 饼图/表格卡、图表联动、24 列栅格独立模式、模型列表/静态 JSON 数据源 → spec 017 已声明推迟；
- 设计器画布内实时采样预览（12FE §4「应用真实数据」按钮）→ 完整版；本期预览走发布前预览页；
- 自动重试/退避策略 → 只做手动重试按钮；
- React Query 缓存层（12FE staleTime 60s）→ 现宿主手写装载已满足最小闭环，缓存优化随完整版。

## 3. 接口契约（对外的稳定承诺）

### 3.1 RequestClient.aggregate 扩展（可选参数——向后兼容）

```ts
// request.ts：body 增加可选 signal 透传（fetch AbortController）
client.aggregate(modelId, body, options?: { signal?: AbortSignal }): Promise<{ rows: AggRow[] }>
```

- 既有调用面（DashboardPageHost/designer 预览）零改动——第三参可缺省；
- 取消语义：abort 后 fetch 抛 AbortError，宿主按「请求已取消」静默处理（不进错误态）。

### 3.2 DashboardPageHost 装载循环（内部结构——取消/重试语义）

```
装载循环：AbortController 每轮新建 → 各节点请求携带 signal →
  组件卸载或 chartNodes 变更时 controller.abort() → 在途 promise 按 AbortError 静默丢弃
重试：ChartShell error 态按钮回调 → 按节点重发（不动其他节点状态）
```

### 3.3 不变的契约（声明）

- `ChartDs`/`AggRow`/三物料 componentName/`PAGE_TYPES` 含 DASHBOARD——均已在 spec 017 冻结，本 spec 零协议变更；
- 发布兼容策略不变：无 schemaVersion 升级、后端零改动。

## 4. Tasks（任务清单，执行时逐项勾选）

- [ ] T1 request.ts：aggregate 增加可选 `{ signal }` 参数透传 fetch
- [ ] T2 DashboardPageHost：AbortController 装载循环（卸载/重装载 abort）+ 错误态重试按钮（按节点重发）
- [ ] T3 预览链路核对：设计器预览按钮打开的预览页对 DASHBOARD 页走 DashboardPageHost（真实聚合）——
      如已通则只补测试断言；不通则修通
- [ ] T4 测试：取消（abort 后旧响应不落 state）/ 重试（错误节点重发成功后恢复 done 态）单测
- [ ] T5 spec 017 任务与验收逐条核对：实现面已覆盖的 T1-T8/A1-A7 直接勾选并注明「随 018 验证通过」；
      人工链路（A2/A3 手工验证）执行后勾选
- [ ] T6 验证：全量 `pnpm test` + `verify.ps1`；spec 017 与本 spec 状态流转（draft→done）

## 5. Acceptance（验收标准，可测试）

- [ ] A1 `verify -Level commit` 通过（前端 tsc/build/test 全绿）
- [ ] A2 页面切换时在途聚合请求被 abort——旧响应不写入新页面图表 state（单测断言）
- [ ] A3 聚合失败 → Card 错误态显示「重试」→ 点击重发 → 成功后恢复图表（单测断言）
- [ ] A4 设计器：DASHBOARD 页拖入柱状图配置数据源 → 预览页渲染真实聚合数据（人工链路）
- [ ] A5 发布后运行时打开该页：图表渲染与设计预览一致（人工链路，spec 017 A3 同源验证）
- [ ] A6 权限红线：前端仅传 AggregateRequest，无全量查询后前端过滤（代码审查断言——collectChartNodes 只发聚合）
- [ ] A7 spec 017 的 A1-A7 全部勾选闭环（本 spec T5 完成的映射记录）
- [ ] A8 时间桶边界：无 filter 双边范围的后端 400 错误在 Card 内可见（不白屏不静默）

## 6. 验证步骤（人可复跑）

```text
1. pnpm --filter @schema/runtime run build && pnpm --filter @schema/runtime test
2. powershell -File scripts\verify.ps1
3. 人工链路：设计器建 DASHBOARD 页 → 拖 BarChart → 配模型+measures+group → 预览页验证真实数据
   → 发布 → 运行时打开同页对比一致性 → 断网/错模型触发错误态 → 重试恢复
4. spec 017 §4/§5 勾选状态与本 spec §5 对齐后，双 spec 置 done
```

## 7. 沉淀记录（结项时回填）

- （待回填）
