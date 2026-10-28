# 详细前端技术文档 16 · shared-ui 共享组件包（packages/shared-ui）

> 上游：《技术方案-前端(React).md》v0.3 §2（Monorepo 包结构）；架构总纲 00FE §2（L3 平台层）
> 本文定位：**实现级技术设计**——组件清单、收录判据、任务中心与导入导出 UI 归属、与物料层的边界
> 包：`packages/shared-ui`（L3 平台层——三应用共用的**界面级**组件底座）

---

## 1. 职责边界（三处边界必须分清）

| shared-ui | component-materials | 各 app 页面代码 |
|---|---|---|
| **界面级**通用组件：三应用都要的壳/表格/表单/反馈 | **Schema 驱动**的低代码物料（MaterialMeta 协议） | 业务页面组装（路由/布局/页面级状态） |
| 组件带 props 直接用，无协议绑定 | 组件经 NodeRenderer 分派渲染 | — |
| 例：PageShell、DataTable、TaskCenter | 例：basic.Table、biz.UserPicker | 例：admin-console 用量页 |

**收录判据（PR review checklist）**：一个组件进 shared-ui 当且仅当 **≥2 个应用**需要且**不含业务语义**（模型/流程/页面概念一律不进——那是 L2 物料或 L4 页面的职责）。单应用需要的组件放该 app 内部。

## 2. 组件清单

### 2.1 布局与导航壳

| 组件 | 用途 | 消费方 |
|---|---|---|
| `PageShell` | 页面骨架：标题栏/操作区/内容区/面包屑 | 三应用全部页面 |
| `AppLayout` | 应用级布局：侧栏菜单 + 顶栏 + 内容（菜单树消费后端 13 §A.2 nav 接口，权限过滤后的树直渲染） | runtime、admin-console |
| `TabNav` | 页签导航（应用设置四页签类场景） | designer、admin-console |
| `theme`（ThemeProvider） | 主题引擎（文档 13FE，随包导出） | 三应用 |

### 2.2 数据展示

| 组件 | 用途 | 关键约定 |
|---|---|---|
| `DataTable` | 标准管理表格：分页/排序/筛选条/批量选择/列配置 | 封装 AntD Table + request-sdk 分页协议（`{list,total,page,size}`）；与物料 `basic.Table` 共享列渲染器工厂（格式化：日期/千分位/枚举标签色——两处同一实现） |
| `DescriptionList` | 详情页键值展示 | 字段权限剔除后的「键缺失」容错渲染（后端 03BE §3.4 契约的前端体现） |
| `StatCard` | 指标卡（用量页/仪表盘数值卡同源） | quotaStatus 三态着色（OK/SOFT/HARD，文档 14FE §3） |
| `ChartKit` | ECharts 封装层（文档 12FE §2，图表物料与 admin 报表共用） | — |

### 2.3 表单与操作

| 组件 | 用途 | 关键约定 |
|---|---|---|
| `QueryForm` | 查询条件区（字段 × 操作符 × 值 → ConditionTree） | 与物料筛选器共享 encodeQuery（文档 07FE §3 契约） |
| `ConfirmDanger` | 危险操作二次确认（停服/删除/席位清理） | 文案规范：后果 + 可逆性 + 时效（「次日生效」类延迟提示强制包含） |
| `QuotaExceededDialog` | 配额超限升级引导弹层 | 消费 `QUOTA_EXCEEDED` payload `{upgradeUrl, metric, limit}`（文档 07FE §4 约定的统一消费组件） |
| `SecretOnceView` | 明文一次性展示（API Key/密钥尾码） | 关闭即丢弃、禁复制提示音、无日志（文档 14FE §4） |

### 2.4 任务与文件（导入导出 UI 归属——本包收口）

**任务中心 TaskCenter**（此前「批量导入导出前端归属不明」缺口的落点）：

```
定位：全平台异步任务的统一 UI 宿主（后端文档 10BE §A.4 通用任务协议）
  任务类型注册表：[{ taskType: 'data.export', label: '数据导出', icon },
                   { taskType: 'data.import', label: '数据导入' },
                   { taskType: 'ddl.promote', label: '索引字段生效' },
                   { taskType: 'app.export', label: '应用导出' }]

入口形态两种：
  ① 顶栏铃铛抽屉（全应用可见）：进行中任务进度 + 最近完成/失败列表
  ② 页内嵌入卡片（触发任务的页面原地显示）：导入向导步骤条/导出按钮态

协议消费：POST 触发 → {taskId} → 轮询 GET /api/tasks/{taskId}
  （状态机 PENDING/RUNNING/SUCCESS/FAILED/EXPIRED；进度百分比；失败原因透传）
下载：SUCCESS 态渲染下载按钮 → file-service 下载凭证（文档 11BE §A.2，现取现用）
```

**导入导出触发点的页面归属**（消费 TaskCenter，不在本包）：

| 触发点 | 页面 | 接口来源 |
|---|---|---|
| 模型数据导入（Excel 批量建数据） | ER 建模器模型详情抽屉（文档 10FE §新增章节） | 后端 02BE §A.4 `/import` |
| 列表页导出（当前筛选条件） | 运行时列表页「导出」按钮（物料 Table 工具栏扩展位） | 后端 02BE §A.4 `/export` |
| 应用导出/导入（.schema-app） | admin-console 应用管理页 | 后端 13BE §A.4 |

### 2.5 反馈与状态

| 组件 | 用途 |
|---|---|
| `EmptyState` | 空态占位（区分：无数据/无权限/加载失败/未配置四态） |
| `ErrorBoundaryFallback` | 错误分级占位统一渲染（L-Schema/L-Node 分级文案，文档 02FE §8） |
| `NotificationCenter` | 通知中心（站内信列表/红点/全读，消费后端 12BE §A.1；WS 推送接入在运行时容器） |

## 3. 工程约束

- **依赖纪律**：shared-ui 只依赖 request-sdk/auth-sdk/L1 协议类型（L3 同层互引走公共导出）；**禁止依赖 L2 引擎**（schema-renderer/component-materials）——反向依赖即洋葱违规（CI dependency-cruiser）；
- 与物料的共享实现（列格式化器、encodeQuery、ChartKit）一律**定义在 shared-ui 导出**，物料层 import 消费——单一实现源；
- 组件文档：Storybook 目录随包；每个组件必须有「受控/非受控/错误态」三个基础 story（验收基线）；
- bundle 策略：按组件独立分片（tree-shaking 友好）；AntD 全量引入零容忍（复用物料层按需引入配置）。

## 4. 单元测试硬性要求

- [ ] 收录判据扫描：shared-ui 导出项引用方 <2 应用时 CI 告警（防组件库腐化）
- [ ] TaskCenter：任务注册表驱动渲染；轮询 SUCCESS 后进度定格 + 下载按钮出现；FAILED 原因透传
- [ ] DataTable：分页协议对齐（page/size/total）；列格式化器与物料 basic.Table 快照一致（同源断言）
- [ ] QueryForm：操作符白名单约束（11 个）与 encodeQuery 映射（契约测试锁定，文档 07FE §3）
- [ ] SecretOnceView：关闭后组件状态树无明文残留；无 console 输出
- [ ] QuotaExceededDialog：payload 结构解析 + 升级链接打开；与后端错误协议字段对齐
- [ ] 依赖断言：无 L2 引擎 import；AntD 按需（bundle 分析门禁）

---

## 附录 · 对接接口清单（消费方视角）

| # | 接口 | 用途 | 来源（后端文档） |
|---|---|---|---|
| 1 | `GET/POST /api/tasks/{taskId}` 等（任务协议） | TaskCenter 轮询与触发透传 | 10 §A.4 |
| 2 | `GET /api/notifications*`（站内信五接口 + WS） | NotificationCenter | 12 §A.1 |
| 3 | `GET /api/files/{fileId}/url` | 任务完成后的下载凭证 | 11 §A.2 |
| 4 | `GET /api/apps/{id}/nav` | AppLayout 菜单树（权限过滤后直渲染） | 13 §A.2 |
| 5 | 分页/错误协议 | DataTable/QueryForm 的协议基座 | 10 §A.1/A.2（通用约定） |

**对接约束**：TaskCenter 是任务 UI 的唯一宿主——任何新异步任务类型只注册 `taskType` 清单项，不另建任务列表页（防三应用各养一套任务中心漂移）。
