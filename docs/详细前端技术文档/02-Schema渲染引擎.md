# 详细前端技术文档 02 · Schema 渲染引擎（schema-renderer）

> 上游：《技术方案-前端(React).md》v0.2 §3.2/§3.9；PRD §6.2（双轨渲染决策）、§3.1.1（已删字段兼容）
> 本文定位：**实现级技术设计**——渲染管线、双轨分派、字段级订阅、性能预算、错误分级
> 包：`packages/schema-renderer` ★设计器预览与运行时共用的唯一渲染核心

---

## 1. 职责边界

| 负责 | 不负责 |
|---|---|
| LayoutNode[] → React 组件树的分派渲染（轨道 A/B 统一入口） | 物料组件实现（component-materials） |
| 表达式绑定的求值与**字段级订阅**装配 | 表单状态管理（schema-form 的 formStore） |
| DesignMode / RuntimeMode 双模式（条件编译同源） | Schema 校验（协议层职责，本包调用） |
| 渲染层错误分级与 ErrorBoundary 体系 | 数据获取（request-sdk 职责，本包消费 ctx） |

## 2. 渲染管线

```
PageSchema (published)
  │ ① validate（zod）+ migrate（schemaVersion）   ← 协议层
  ▼
  ② collectDependencies(layout)                    ← 全树扫描 ExpressionBinding.dependsOn
  ▼
RenderScope 构建（字段级订阅的原子 store）
  │ formStore + listData + globalContext 以 valtio 原子化代理形式注入
  ▼
  ③ NodeRenderer 递归渲染
  │    ├─ resolveProps：PropValue 求值（表达式 → 当前值；静态 → 透传）
  │    ├─ DELETED 字段过滤：fieldRef 指向 DELETED 字段的节点 → 弃用占位（设计态标黄，运行态隐藏）
  │    └─ 双轨分派（§3）
  ▼
  ④ ActionDispatcher 挂载（按钮类 props.actions → 事件编排执行）
  ⑤ responsiveTransform(layout, viewMode)          ← 移动端响应变换（P1 保底/P2 配置覆盖，
                                                      实现见前端文档 15 §3；desktop 视图短路零开销）
```

## 3. 双轨分派（PRD §6.2 落地核心）

```tsx
function NodeRenderer({ node, ctx }: { node: LayoutNode; ctx: RenderCtx }) {
  const material = materialRegistry.get(node.componentName);
  if (!material) return <UnknownWidget name={node.componentName} />;

  const props = resolveProps(node.props, ctx);

  if (material.runtime === 'compiled') {
    // 轨道 B：异步加载编译产物，Suspense + ErrorBoundary + 旧版本兜底
    const Artifact = useArtifact(material.artifactHash);   // import(artifactUrl) + 3 次重试
    return (
      <ArtifactErrorBoundary fallback={<ArtifactFallback hash={material.artifactHash} />}>
        <Suspense fallback={<NodeSkeleton />}>
          <Artifact {...props} ctx={ctx} />
        </Suspense>
      </ArtifactErrorBoundary>
    );
  }

  // 轨道 A：动态解析（默认）
  const Comp = material.component;
  return <Comp {...props} data-node-id={node.id} />;
}
```

| | 轨道 A 动态解析 | 轨道 B 编译产物 |
|---|---|---|
| 判据 | propsSchema 可描述 | 需要自定义逻辑/DOM |
| 生效 | Schema 保存/发布即生效（不发版） | 保存即编译，产物 hash 更新 |
| 加载 | 物料注册表按需分片 `React.lazy` | `import(artifactUrl)`（contentHash 长缓存） |
| 失败表现 | 表达式错误设计态阻断 | 编译失败线上跑旧版；加载失败 ErrorBoundary 占位 |
| 统一 | 均由 `MaterialMeta.runtime` 分派，NodeRenderer 单入口 | 同左 |

**轨道 B 关键约束**：

- CSP `script-src 'self'` + 禁 `unsafe-eval`——产物必须是后端 build-service 预编译的 ES module（后端文档 04 §2.5）；
- 产物 URL 即 `artifacts/{tenantId}/{sha256}.js`，`immutable` 长缓存，无版本协商开销；
- 加载失败 3 次重试（指数退避）后节点级占位，绝不白屏；产物契约：默认导出 React 组件或 `render(ctx)`。

## 4. 字段级订阅（性能核心）

**问题**：一个大 context 会导致任一字段变化触发全树重渲染（PRD 性能红线：100 字段表单首屏 < 1s、无整页重渲染）。

```
方案：valtio 原子化 store + useSnapshot 细粒度选择器

// 表达式订阅组件：每个 ExpressionBinding 编译产物包一层
function ExprBinding({ ast, deps, ctx }: ...) {
  // deps = dependsOn；仅订阅这些字段的快照切片
  const snap = useSnapshot(ctx.formStore, { sync: true });
  const scope = pick(snap, deps);              // 按依赖精确取值
  return evaluate(ast, scope);
}
```

- 订阅粒度 = `dependsOn` 字段集合；`amount` 变化只重渲染引用 `amount` 的表达式与其挂载节点；
- 列表页：`listData` 独立原子，分页/筛选变化不触发表单区；
- 兜底：依赖扫描（管线 ②）漏标时退化为全量订阅并上报遥测（观测欠账，不静默）。

## 5. DesignMode / RuntimeMode 同源

```
schema-renderer/
├── src/core/            # 双模式共用：NodeRenderer、resolveProps、RenderScope
├── src/design/          # DesignModeWrapper：选中框/拖拽手柄/右键菜单/标黄警示
│                        #   入口 designer.ts（条件编译包含）
└── src/runtime.ts       # 运行时入口：tree-shaking 掉 src/design（Vite define + 两套 entry）
```

- 同源保证「设计器看到的 = 线上跑的」（PRD §6.2）；
- DesignMode 额外能力：节点 hover 边框、选中态、大纲树高亮联动、引用 DELETED 字段节点标黄（详细 PRD 02 §2.1）；
- 运行时产物不含 `src/design` 任何代码（CI 断言 bundle 无设计器符号）。

## 6. 已删除字段兼容（PRD §3.1.1）

- 渲染前统一过滤：`fieldRef` 指向 `fieldStatus='DELETED'` 的节点 → 运行态渲染为 `null`（不占位不报错），设计态标黄警示节点；
- 表达式引用已删字段：**显式错误**（`FieldMissingError`），不静默 `undefined`（静默会把比较类联动变成永假，排查成本极高）；
- 数据源列/筛选器绑定已删字段：请求构建阶段剔除该列，避免后端 400。

## 7. 性能预算与手段

| 场景 | 预算 | 手段 |
|---|---|---|
| 100 字段表单首屏 | < 1s | 物料懒加载分片、`useTransition` 让交互优先 |
| 1 万行列表 | 不掉帧 | react-window 虚拟滚动、列级 memo |
| 200 节点画布操作 | < 100ms | immer 结构共享 + 字段级订阅、拖拽期间 `startTransition` |
| 表达式求值（单节点） | < 1ms | AST 编译缓存（source → ast LRU） |

## 8. 错误分级（白屏是不可接受的体验事故）

| 级别 | 来源 | 表现 |
|---|---|---|
| L-Schema | zod 校验失败 / FutureSchemaVersion | 页面级 SchemaError 占位 + 上报 |
| L-Node | 物料组件运行时异常 | 节点级 ErrorBoundary → 该节点占位，兄弟节点正常 |
| L-Expr | 表达式求值异常 | 绑定降级为默认值 + 控制台告警 + 上报 |
| L-Artifact | 轨道 B 加载/执行失败 | 产物占位 + 重试按钮；旧版本兜底由后端保证 |

每级错误都带 `pageId/nodeId/traceId` 结构化上报（usage-tracker 通道，不计费仅观测）。

## 9. 单元测试硬性要求

- [ ] 双轨分派：`runtime:'dynamic'` 与 `'compiled'` 各走对应分支；未注册物料渲染 UnknownWidget
- [ ] 字段级订阅：修改字段 A 仅重渲染引用 A 的节点（React Profiler 断言渲染次数）
- [ ] DELETED 字段：三类引用（fieldRef/表达式/数据源列）全部按 §6 处理
- [ ] 轨道 B：产物加载失败重试 3 次后占位且不白屏；Suspense 骨架正常
- [ ] 运行时 bundle：CI 断言无 `src/design` 代码包含
- [ ] 性能基准测试（CI 门禁）：100 字段表单渲染时长断言

---

## 附录 · 对接接口清单（消费方视角）

> 本模块不发请求；以下接口由宿主（设计器/运行时）注入的 ctx 实现。路径与参数定义见对应后端文档附录 A。

| # | 接口 | 用途 | 来源（后端文档） |
|---|---|---|---|
| 1 | `GET /api/runtime/pages/{pageId}`（`If-None-Match` → 304/200+ETag） | 渲染管线①的 published Schema 输入；响应含权限过滤后字段元数据摘要 | 04 §A.4 |
| 2 | `GET /api/data/{modelId}`（ConditionTree query，size≤200） | RenderScope.listData 数据源；列表页主查询 | 02 §A.1/A.2 |
| 3 | `GET /api/data/{modelId}/{id}` | 详情页/表单回填数据源 | 02 §A.1 |
| 4 | `POST /api/data/{modelId}` / `PUT /api/data/{modelId}/{id}` | ActionDispatcher 的 SUBMIT 动作链 | 02 §A.1 |
| 5 | `DELETE /api/data/{modelId}/{id}` | DELETE 动作（逻辑删除） | 02 §A.1 |
| 6 | `POST /api/data/{modelId}/unique-check` | 校验管线异步唯一性（经 schema-form 触发） | 02 §A.3 |
| 7 | `POST /api/flows/{defId}/instances` | TRIGGER_FLOW 动作（携 `{modelId, recordId}`） | 05 §A.2 |
| 8 | 轨道 B：`import(artifactUrl)` | 编译产物加载；URL 来自 Schema 的 `artifactHash`（后端构建 §2.3） | 04 §A.5 |
| 9 | 错误归一化依赖 | 全部接口错误体 `{code, message, traceId}` → `ApiError`；`QUOTA_EXCEEDED` 升级引导统一弹层 | 10 §A.2 / 09 §A.3 |

**对接约束**：

- ActionDispatcher 执行动作链前必须过按钮权限（`perms` 含 `action:{key}`，权限快照来自 `GET /api/me`，后端 03 §A.2）；
- 数据源请求由 request-sdk hooks 承担（queryKey 结构化）；本模块只声明 DataSourceBinding，不直接发 fetch（DIP，架构总纲 §4.4）。
