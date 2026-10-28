# 详细前端技术文档 04 · 页面设计器 Canvas 引擎（designer-canvas）

> 上游：《技术方案-前端(React).md》v0.3 §3.4/§3.2；详细 PRD 02（操作级需求全量）
> 本文定位：**实现级技术设计**——设计器状态机、拖拽管线、撤销重做、属性面板生成、冲突处理
> 包：`apps/designer`（画布引擎模块）+ `component-materials`（propsSchema 消费）

---

## 1. 职责边界

| 负责 | 不负责 |
|---|---|
| 画布拖拽/选中/移动/嵌套落点计算（@dnd-kit） | 节点渲染本体（schema-renderer DesignMode） |
| 设计器文档状态：Schema 草稿 + 撤销重做栈 + 自动保存 | Schema 持久化（request-sdk → page-service） |
| 属性面板由 propsSchema 自动生成（"用低代码编辑低代码"） | 物料 propsSchema 定义（物料作者职责） |
| 编辑锁心跳/冲突 409 三方对比交互 | 锁服务端逻辑（后端 Redis） |

## 2. 设计器状态架构

```
Zustand（designerStore）                React Query（服务端状态）
├─ doc: PageSchema（immer draft）       ├─ usePage(pageId)            # published/draft 拉取
├─ selection: { nodeId | null }         ├─ useModelMeta(modelId)      # 字段元数据（含 DELETED）
├─ clipboard / dragState                ├─ useLockState(pageId)       # 编辑锁状态轮询
├─ history: { past: Snapshot[], future: Snapshot[] }   # 快照栈，容量 50
└─ dirty: boolean（触发自动保存）

铁律：画布渲染只读 doc；一切修改必须经 commands（可撤销操作的唯一入口），
     直接改 doc 的代码路径在 code review 层禁止（lint 规则约束 zustand set 的调用点）。
```

## 3. 命令系统与撤销重做

```ts
interface Command {
  do(doc: Draft): void;          // immer patch
  undo(doc: Draft): void;        // 反向 patch
  label: string;                 // 撤销提示文案「删除组件 Input」
}

execute(cmd):
  1. cmd.do(next = produce(doc, cmd.do))
  2. history.past.push({snapshot: doc, cmd}); future 清空; dirty=true
  3. 提交 store → DesignMode 画布按字段级订阅局部更新

undo(): 取 past 栈顶恢复；redo(): 取 future 栈顶
快照策略：结构共享（immer）使 50 步栈内存可控；不做 diff patch（复杂度不划算，200 节点规模快照拷贝 < 1ms）
自动保存：dirty && 30s 节流 → PUT draft（后端 draft_version 递增）；保存前后状态一致才清 dirty
```

## 4. 拖拽管线（@dnd-kit）

```
物料面板拖出 → onDragStart：注册 dragPayload { componentName }
  → 画布 onDragOver：
     落点检测 = 命中容器节点的有效投放区（流式布局：行间指示线）
     嵌套校验：目标容器 acceptChildren（物料协议声明）+ 深度 ≤ 8 + 禁自嵌套（拖动子树时排除）
  → onDragEnd：
     execute(InsertCommand { parentId, index, node: newLayoutNode(componentName) })
     新节点 ULID id 生成；默认 props = material.defaultProps

画布内移动：同管线，InsertCommand 换 MoveCommand（先移除后插入，一条命令保持撤销原子性）
大纲树拖拽：树控件复用同命令系统（保证操作来源无关、撤销栈一致）
```

- 仅流式/栅格布局（PRD 边界）：落点指示为插入位序，无绝对坐标；
- 拖拽期间 `startTransition`：选中态/指示线即时响应，Schema 重渲染降级过渡（性能预算 §7 详细 PRD 02）。

## 5. 属性面板自动生成

```
选中节点 → 右面板 = <SchemaForm schema={material.propsSchema} value={node.props} />
分组渲染：基础属性 / 数据绑定 / 联动规则 / 事件动作 / 高级（详细 PRD 02 §2.2.2）

字段绑定下拉：useModelMeta → 仅 ACTIVE 字段可选；DELETED 字段置灰分组显示
  （选中已删字段时节点标黄 + 提示文案——差异检测的表现层）

修改回写：onChange → execute(UpdatePropsCommand { nodeId, propPath, value })
表达式属性：输入框内联 L1 校验（协议层 ExprEngine），错误标红阻断失焦
```

## 6. 模型差异检测（详细 PRD 02 §2.1）

```
触发：打开设计器 / 切换关联模型 / 元数据失效推送到达
算法：
  refs = collectFieldRefs(doc.layout)          # 全树 fieldRef + 表达式 dependsOn
  meta = useModelMeta(modelId)
  warnings = refs.filter(r => meta[r]?.fieldStatus === 'DELETED' || !meta[r])
表现：画布节点标黄 + 属性面板警示条 + 顶部「N 处引用异常」汇总入口
阻断：仅在保存时校验（黄色警示不阻断继续编辑——尊重渐进修复）
```

## 7. 编辑锁与冲突（对接后端文档 04 §1.5）

```
进入设计器：
  POST 锁 → 成功：开启心跳（10s 续期）；失败：提示持锁人 + 「申请强制解锁」
心跳失败（网络/掉线）：< 60s 宽限内本地续试；超时 → 只读模式横幅 + 本地草稿保留
保存 409（baseVersion 冲突）：
  三方对比弹层：我的草稿 / 服务器最新 / 合并起点
  P1 提供「以我为准覆盖 / 放弃我的修改拉取最新」二选一；逐节点合并 P2 再做（不做自动合并）
```

## 8. 单元测试硬性要求

- [ ] 命令系统：任意操作序列 undo/redo 后 doc 深比较相等
- [ ] 嵌套校验：不可容器/超深/自嵌套三种落点被拒
- [ ] 自动保存：30s 节流合并多次编辑为一次 PUT；保存失败 dirty 保持
- [ ] 差异检测：DELETED/不存在字段引用被标黄；保存时校验触发
- [ ] 属性面板：propsSchema → 表单渲染正确；表达式错误阻断失焦
- [ ] 冲突 409：三方对比展示与两种解决路径的数据流
- [ ] 性能基准：200 节点画布拖拽操作响应 < 100ms（CI 门禁）

---

## 附录 · 对接接口清单（消费方视角）

> 路径与参数详见对应后端文档附录 A；错误体统一 `{code, message, traceId}`（后端 10 §A.2）。

| # | 接口 | 用途 | 来源（后端文档） |
|---|---|---|---|
| 1 | `GET /api/pages/{id}/draft` | 打开设计器加载草稿 `{schema, draftVersion}` | 04 §A.1 |
| 2 | `PUT /api/pages/{id}/draft`（30s 节流自动保存 + 手动保存） | 保存 `{schema, baseDraftVersion}` → `{draftVersion}`；`409 {serverDraftVersion}` 进三方对比（§7） | 04 §A.1 |
| 3 | `POST /api/pages/{id}/lock` / `lock/heartbeat`（10s）/ `DELETE lock` | 编辑锁获取/续期/释放；`409 {holder}` 显示持锁人 | 04 §A.3 |
| 4 | `GET /api/models/{id}` | 属性面板字段绑定下拉（ACTIVE 过滤 + DELETED 置灰）；模型差异检测元数据源 | 01 §A.1 |
| 5 | `POST /api/build/pages/{pageId}/code` | 轨道 B「自定义代码」保存即编译：成功更新 artifactHash；失败展示 `{errors:[{line, column, message}]}` | 04 §A.5 |
| 6 | `GET /api/build/tasks/{taskId}` | 编译任务轮询（2s+退避） | 04 §A.5 / 10 §A.4 |
| 7 | `POST /api/pages/{id}`（复制）/ `DELETE`（删除）/ `PUT /path` | 页面列表操作（复制重生成节点 id；删除返回 `{menuRefs[]}` 提示） | 04 §A.1 |
| 8 | `POST /internal/references`（经后端 page-service 代发） | 保存时字段引用登记——设计器只产出 dependsOn，不直调内部接口 | 01 §A.4 |

**对接约束**：

- 保存链路时序：`PUT draft` 成功 → 若含轨道 B 代码则 `POST code` → 编译失败仅提示（线上旧版兜底，后端 04 §2.3⑤）；
- `409` 三种来源在本模块汇聚处理：编辑锁（LOCK_HELD_BY_OTHER）、草稿版本（DRAFT_VERSION_CONFLICT）、构建配额（BUILD_QUOTA_EXCEEDED，429 提示稍后再试）。
