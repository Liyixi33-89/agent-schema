# M14 运行链修复证据 · 消息桥接通 / ready 握手 / 静态快照 / 编译超时

- **run-id**: 20261110-165800-3d41186
- **commit**: 3d41186（分支 m14-runtime-fixes，基于 master c9d4698）
- **日期**: 2026-11-10
- **执行环境**: 本地 Windows（PowerShell 5.1）+ WSL PG 17（localhost:5432 镜像网络）
- **supersedes**: 无（增量修复，不改写 20261110-160500-e5fe6c2 的历史结论；该 run 的「运行期链路已验收」表述由本 run 修正）

## 修复背景（2026-11-10 下午独立复核发现的真实缺陷）

| # | 缺陷 | 严重度 | 根因 |
|---|------|--------|------|
| 1 | 真实消息桥未接通：`ScriptHost.invoke()` 只处理 `hook-done`，Worker 发出的 `ctx-call` 被静默丢弃，`bridge.dispatch()` 从未被调用 | 阻断 | 旧单测 FakeWorker 自造简化协议（只回 hook-done、`fn(payload)` 单参调用），掩盖真实 bootstrap 的缺陷 |
| 2 | init 竞态：`createScriptWorker()` 构造期发 `init`，而 ScriptHost 的消息监听在 `runOnWorker` 才挂载——`ready` 早于监听就绪会被丢弃；`awaitReady` 永远等不到 | 阻断 | 构造期发送 vs 监听后置的时序错配 |
| 3 | 静态快照断裂：`staticUser/staticPage` 随 `init` 发送，bootstrap 却从 `run` 消息读取 → 钩子内 `ctx.user/ctx.page` 恒 undefined | 阻断 | bootstrap 消息字段读取错位 |
| 4 | 编译超时不可达：`NodeBuildWorker.compile()` 先 `readAllBytes()` 阻塞读 stdout，再限时 `waitFor()`——进程挂起不关流时永远到不了超时判定；stderr 未排空可致管道缓冲满死锁 | 高 | 阻塞读流先于限时等待 |
| 5 | mock 桥 `form.get` 读 `args[1]`（实际只传 `[fieldKey]`）恒 undefined——测试台演示不了任何表单往返 | 中 | mock 处理器参数序错误 |

**澄清（非缺陷）**：钩子统一 `fn(payload, ctx)` 调用符合 08FE §4.3 执行流程契约，无需按钩子分派签名；真实问题是 ScriptPanel 示例脚本签名错误（`beforeSubmit(ctx)` 收到的是 payload）。

## 修复内容（commit 3d41186，5 文件 +243/-39）

1. **ScriptHost 常驻消息分派器**（`script-host.ts`）：`runOnWorker` 挂载常驻 listener 统一处理 `ready`/`ctx-call`/`hook-done`；`ctx-call` → `bridge.dispatch(op, args)`（白名单校验层）→ 回执 `ctx-result`；`init` 由宿主显式驱动并携带 `artifactUrl/staticUser/staticPage`（新增 options 契约字段）；ready 握手带 5s 兜底超时。
2. **worker-bootstrap 静态快照**（`worker-bootstrap.ts`）：`init` 存 `staticUser/staticPage` 变量，`run` 时注入 ctx（原从 run 消息读取恒 undefined）。
3. **NodeBuildWorker 超时并发边界**（`NodeBuildWorker.java`）：限时 `waitFor` 前置；stdout 缓冲式并发排空（`CompletableFuture.runAsync` + `transferTo`）；stderr 并发排空防缓冲满；异常退出附 stderr 摘要。
4. **FakeWorker 升级为协议真实镜像**（`script-host.test.ts`）：init→ready 握手、`fn(payload, ctx)` 两参、ctx-call→宿主桥→ctx-result 全往返、静态快照来自 init、终止后不派发——消除旧版自造协议的测试盲区。
5. **mock 桥真实表单状态**（`script-host.ts`）：`createMockBridge` 持 `form` 状态对象，`form.get/set/getValues/setValues` 读写一致；新增 `initialForm` 注入参数。
6. **ScriptPanel 示例修正**：`beforeSubmit(payload, ctx)` 签名 + payload 优先、`ctx.form.get` 兜底；桥注入样例值 `{ amount: '20000' }`。

## 测试运行实录

### @schema/script-host（39/39，较修复前 35 → +4）
```
✓ test/redline-scanner.test.ts (25 tests)
✓ test/script-host.test.ts (14 tests)    ← 原 10：+桥往返协议镜像 +ready 竞态 +静态快照注入 +钩子未导出
Tests  39 passed (39)
```
新增回归用例（协议镜像级，旧 FakeWorker 全部无法覆盖）：
- 真实桥往返：钩子内 `ctx.form.get` 经宿主桥取值（断言 `bridge.calls` 含 `form.get` 且值真实返回）
- ready 竞态：init 异步 60ms 慢于调用不被「module 未加载」误杀
- 静态快照经 init 注入：钩子读到宿主携带的 `ctx.user/ctx.page`（修复前恒 undefined）
- 钩子未导出返回明确错误

### verify[commit]（十一步全绿，本地实测 119248ms）
```
[PASS] doc-anti-corruption (1751ms)
[PASS] frontend-tsc (2239ms)
[PASS] backend-compile (4051ms)
[PASS] contract-diff (14531ms)
[PASS] evidence-gate-test (5434ms)
[PASS] workflow-gate-test (11967ms)
[PASS] frontend-build (2080ms)
[PASS] frontend-test (11765ms)
[PASS] backend-test (18504ms)
[PASS] backend-it (22633ms)
[PASS] acceptance-archives (1487ms)
===== verify[commit] PASS (119248ms) =====
```
（PowerShell 下 Exit code 1 为既有误报——git/mvn 进度写 stderr；十一步 PASS 判定以输出为准，与 M13/M14 前序 run 同口径。）

## 遗留登记（不宣称完成）

| 项 | 说明 | 归属 |
|----|------|------|
| PageSchema.scripts 持久化闭环 | 协议冻结态字段变更（PageSchema 无 `scripts` 字段）需走 schemaVersion 破坏性升级流程 + 人类授权；页面保存携带绑定、重新打开恢复、发布快照携带、runtime 消费钩子的完整链路未落地 | M14 后续 / 协议变更流程 |
| 真实浏览器 G7 证据 | 死循环 terminate 后页面可交互、消息桥真实往返、CSP 阻断的浏览器级实测仍未执行（本轮为协议镜像级单测） | M15 安全验收一并执行 |
| Monaco 编辑器 | 编辑期标红以 scanSource 列表呈现（基线偏离既有登记不变） | P2 评估 |

## 结论

本轮修复消除了 M14 运行链的四个阻断级缺陷（消息桥、ready 竞态、静态快照、编译超时）与测试盲区（FakeWorker 协议镜像化）；单测与 verify 全绿。但 **PageSchema.scripts 持久化闭环与真实浏览器 G7 证据仍未落地**——M14 维持 `implemented`，不得以本 run 单独转 `accepted`。
