# M12 验收报告（2026-11-04 · 基线 83b5d33 → 收口 ee4a356/53cdebd；2026-11-05 补齐收口见 §六）

## 一、验收范围与结论

| 项 | 结果 | 说明 |
| --- | --- | --- |
| er-modeler 主链路 | 48/48 PASS | 浏览器 UI（CDP 真实事件）+ API 断言 + DB 落库核对；fail-fast |
| designer 回归 | 37/37 PASS | 成员/导航/主题/发布 + 越权负例（适配「模型」新页签） |
| runtime 回归 | 23/23 PASS | 真实鼠标提交→POST→DB 精确核对→登出失效 |
| admin 回归 | 23/23 PASS | 成员/用量/健康/公告 + 越权 + 跨租户 |
| cache 回归 | 23/23 PASS | 预览/正式缓存隔离、租户切换菜单重载 |
| verify[commit] | 七步 PASS | doc-anti-corruption/frontend-tsc/backend-compile/contract-diff/frontend-build/frontend-test/backend-test/backend-it |
| 后端集成测试 | 18/18 PASS | MetadataCommandServiceIT（含新增跨应用越权回归） |
| 协议包单测 | 26/26 PASS | save-flow.test.ts（两段式状态机/布局/关系边/草稿 diff/重名判定） |

## 二、P0 安全收口（本轮修复）

1. **编译阻塞**：ModelController 内联 `DesignGate` 声明移除（独立接口 + bootstrap `DesignGateConfig` 装配）。
2. **普通成员越权建模**：`DesignGate.requireDesignCapability`（developer/app_admin/org:manage 三口径）接入模型全链 11 端点；`GlobalExceptionHandler` 补 `PERM_DENIED→403` 映射（DesignGate 从 metadata 包抛出，IAM 域 advice 不接力——此前 400）。浏览器验收实证：普通成员建模/precheck 均 403。
3. **跨应用越权**（应用 A 设计者携 A 的头操作应用 B 的模型）：`loadForTenant` 应用域绑定——`model.appId() != tenant.appId()` 同判 404（不给跨应用存在性线索，与 page 域 `assertAppConsistent` 同构）。覆盖读/precheck/save/rollback 全链。回归测试 `crossAppAccessRejectedEvenWithDesignCapabilityInOwnApp` 入 MetadataCommandServiceIT。

## 三、P1 功能完整性（本轮修复）

| 缺口 | 修复 |
| --- | --- |
| 保存后详情缓存不刷新 | `refreshDetail` 抽出；保存/回滚/409 后强制重拉（懒加载版本号不再停留旧态） |
| 放弃修改不还原草稿 | 按服务端态重建详情草稿（本地编辑不残留） |
| 新增后再删除误发 DELETE_FIELD | `buildDraftChanges` 下沉协议包：本地新增+删除 → 抵消；服务端 DELETED 再删 → 幂等无操作 |
| 字段重名前置校验缺失 | `isDuplicateFieldKey` 本地阻断（服务端 FIELD_KEY_DUPLICATED 兜底） |
| enum/relation/computed 无编辑入口 | 类型相关配置表单（enumOptions 每行 value\|label 校验/relation 目标+基数+级联/computed 表达式+依赖+持久化），修改回填 |
| 删除确认 every([]) 恒真漏洞 | 含删除且无 HIGH 影响面时须显式勾选删除确认（DELETE_ACK_IDX） |
| 回滚预检风险未展示 | 预检影响面先呈现（风险列表/无风险说明），用户输入模型名后确认提交 |
| runRollback 状态竞态 | 预检改显式传参（setState 异步致闭包读旧值——预检静默不发） |

## 四、已知边界（登记不阻塞）

- **基线偏离**：画布为自实现卡片 + SVG 关系边 + 网格布局（非 React Flow + 分层自动布局）。关系边提取 `extractRelationEdges` 与网格布局 `gridLayout` 已单测覆盖；交互降级待产品确认（拖拽自由布局/关系创建入口随 M13 页面设计器统一评估）。
- **关系画布**：关系边仅来自已加载详情的模型（懒加载权衡——全量拉取曾致浏览器 6 连接占满写请求排队超时）。
- **409 冲突**：刷新详情+提示重做（无三方合并）——草稿保护走「放弃修改重建」，与 01BE §4.2 口径一致。

## 五、验证命令

```bash
node scripts/acceptance/accept-er-modeler.cjs   # 48/48 PASS
node scripts/acceptance/accept-designer.cjs     # 37/37 PASS
node scripts/acceptance/accept-runtime.cjs      # 23/23 PASS
node scripts/acceptance/accept-admin.cjs        # 23/23 PASS
node scripts/acceptance/accept-cache.cjs        # 23/23 PASS
powershell -File scripts/verify.ps1 commit      # 七步 PASS
```

环境：WSL PG schema_accept 库 + 后端 18080 + Node 静态代理 8090（Chrome CDP headless，每轮独立 profile）。

## 六、提交

- `ee4a356` feat(designer): M12 ER 建模器前端收口——缓存一致性/配置补全/确认交互
- `53cdebd` fix(metadata): M12 建模授权与跨应用越权收口

## 七、2026-11-05 收口补齐（关系边 0 边修复 + 409/异步验收 + 独立审查）

### 7.1 关系画布 0 边根因与修复（场景⑨闭环）

链路实证（DB 19 条 ACTIVE relation → 后端 fieldView 含 relation 配置 → 前端 73 详情全拉通 → props.edges=19 → DOM 0 边）：

| 层 | 实证结论 |
| --- | --- |
| DB | 19 条 ACTIVE relation 配置完整（`dbq_rel_check.sh`） |
| 后端 | `fieldView` 输出含 relation 键（73/73 详情 200） |
| 前端 props | `ErCanvas` props.details 全满、`extractRelationEdges` 可提 19 条（Fiber 反查实证） |
| React Flow | **节点卡片无 `<Handle>` 锚点——边渲染前置条件缺失，19 条边全部不绘制**（根因） |

修复链（三处）：
1. `ModelNodeCard` 补 target/source Handle（0 边直接根因）；
2. 布局两段式持久化：首载占位坐标不落盘（`layeredLayout(list, [])` 无关系输入退化单行 26280px 宽——落盘会把退化态固化）；`loadAllDetails` 完成后按真实关系边分层重排才持久化（唯一持久化点），旧自实现画布漂移草稿（clientX 数万像素）按 CANVAS_LIMIT=8000 域清理；
3. 重排后 `key={canvasEpoch}` 重挂载画布（React Flow 全量重建节点时 Handle 测量竞态会让边渲染被永久跳过——重挂载触发全新测量）。

辅助修复：`minZoom 0.2→0.02`（退化布局期间 fitView 卡死）；`deleteKeyCode null→['Delete','Backspace']`（恢复键盘删除，实测输入框聚焦豁免生效）。

### 7.2 补验结果

| 脚本 | 结果 | 覆盖 |
| --- | --- | --- |
| accept-m12-closeout.cjs | **18/18 PASS** | A 场景（409 草稿保护全链 13 项）：外部保存制造真实冲突→UI 保存 409→冲突弹层三方差异（本地 draft_field vs 服务端 ext_field）→无偷偷重发（网络断言仅 1 次 POST /schema 且 409）→草稿保留→显式放弃对齐服务端→重编辑用正确版本保存 v4 落库；B 场景：B1 冷启动失败可见（停后端刷新后错误提示非白屏→重启恢复列表）+ 详情 error 态抽屉可见可重试（产品新增）+ B3 快速切换选中态一致 + B4 重复点击仅一次预检、dup_field 落库唯一 |
| accept-er-nine-scenes.cjs | **33/33 PASS**（原 29/30） | 场景⑨修复后：画布边 20/20 与 DB 一致、连线创建落库、删边落库 |
| probe-final2.cjs | PASS | 边数=DB 数、关系链 7 层分层、146 Handle 可连线 |
| probe-delkey.cjs | PASS | 独立审查补测：输入框聚焦 Backspace 不误删节点/边（isInputDOMNode 豁免） |

### 7.3 本轮产品修复清单

| 缺口 | 修复 |
| --- | --- |
| React Flow 节点无 Handle → 0 边 | 补 target/source 锚点 |
| 首载退化布局落盘固化 | 占位不落盘，关系驱动重排才持久化 |
| 旧自实现画布坐标漂移（x≈26000） | CANVAS_LIMIT 域清理 + 重排兜底 |
| 重排后 Handle 测量竞态边消失 | canvasEpoch 重挂载 |
| 详情加载失败抽屉静默不开（open 条件绑 selectedDetail） | error 态也开抽屉：错误文案 + 重试按钮 + 关闭 |
| 抽屉关闭 DOM 残留（幽灵 DOM 吞点击/误断言） | 两个 Drawer 补 destroyOnClose |
| runtime 生产部署缺 vite base（asset 根路径命中 designer 目录） | 新增 vite.config.ts（base /runtime/）——与 designer/admin 同款白屏缺口闭环 |
| 静态代理改写 Host 头致 CSRF Origin 校验 403 | 透传原始 Host（CsrfFilter originOf 按 Host 计算目标源） |

### 7.4 验收环境脚本（重建）

- `serve-acceptance.cjs`：8090 静态代理（三 dist 子路径 + 根路径服务 runtime + /api 反代透传 Host）
- `wsl-run-accept.sh`：后端 18080 启动（setsid 保活）
- `wait-backend.sh`：后端就绪轮询（探活口径：任意 HTTP 响应即活——actuator 需鉴权 200 判定会误报）

### 7.5 独立审查结论（2026-11-05）

- 权限：本轮零后端/权限面改动，前端改动均在视图层 ✓
- 枚举契约：无枚举值变更（上轮 CASCADE_SOFT_DELETE/PERSISTED 修复保持）✓
- 草稿一致性：`refreshDetail` 与显式放弃两条重建路径的 `_deleted` 标记形态一致（防复活误判）✓
- 竞态：background 请求 seq=0 不参与请求序号竞争；用户主动路径保留旧响应丢弃；`loadAllDetails` 就地累积绕开 ref 滞后 ✓
- React Flow 接线：Handle/重挂载/两段式持久化链路自洽；键盘删除豁免实测 ✓
- 回归：verify[commit] 七步 PASS（74s）；ER 主链 48/48；九场景 33/33；designer 37/37；runtime 23/23；admin 23/23；cache 23/23；协议包单测 39/39（新增 canvas-layout.test.ts 4 项）

### 7.6 遗留边界（登记不阻塞）

- 详情 error 态在「后台批量加载已完成」时不可达（缓存全满）——属产品已知边界，冷启动失败可见性由 B1 覆盖
- 409 无三方合并（01BE §4.2 口径：刷新重做）；协议包交付草稿保留+差异展示+显式放弃
- 画布布局对孤立模型仍单行横排（分层算法按关系分层，无关系的 54 个模型天然同层）——交互优化随 M13 统一评估
