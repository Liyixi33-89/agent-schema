# M14 验收证据 · L2 Worker 隔离与最小编译链路

- **run-id**: 20261110-160500-e5fe6c2
- **commit**: e5fe6c2（merge master 54b6dc5，PR #5 三轮 CI 后绿勾）
- **日期**: 2026-11-10
- **执行环境**: 本地 Windows（PowerShell 5.1）+ WSL PG 17（localhost:5432 镜像网络）

## 验收范围（台账 script-isolation）

| # | 要求 | 实现 | 证据 |
|---|------|------|------|
| 1 | 受控消息桥 | `MessageBridge` op 白名单（BRIDGE_OPS）；Worker 内 ctx 只经桥调用，token 永不进执行环境 | script-host 35/35 中 bridge 系列断言 |
| 2 | token 隔离 | Worker 协议消息仅 {type, hook, payload, staticUser/ staticPage}；无凭证字段 | `worker-bootstrap.ts` + script-host.test.ts |
| 3 | 死循环 terminate 后页面可交互 | `hardMs` 超时 `worker.terminate()` 真硬中断 + 主线程 `Promise.race` 双通道拒绝；`run()` 永不抛 | script-host.test.ts 超时系列（修复前 FakeWorker 死循环卡死 tinypool 的负例已覆盖） |
| 4 | 扫描编译 hash 回写 | 保存即编译：`POST /api/build/pages/{pageId}/code` → 红线扫描 → esbuild → contentHash 回写 build_task + 产物落盘不可变 | RedlineVectorTest.artifactImmutableByHash + 冒烟实录 |

## 测试运行实录

### 前端 @schema/script-host（35/35）
```
✓ test/redline-scanner.test.ts (25 tests) 23ms
✓ test/script-host.test.ts (10 tests) 358ms
Test Files  2 passed (2)
Tests  35 passed (35)
```

### 后端红线双端同判（RedlineVectorTest 4/4）
```
Tests run: 4, Failures: 0, Errors: 0, Skipped: 0
redline vectors: 23 条同判一致（allowed=5, blocked=18）
```
- 同判真源：`schema-frontend/packages/script-host/contract/redline-vectors.json`（后端 `build-module/node/` 同步消费，CI contract-diff 步骤并入 FAIL 不降级门禁）

### verify[commit]（十一步全绿，本地实测 96029ms）
```
[PASS] doc-anti-corruption (1742ms)
[PASS] frontend-tsc (3018ms)
[PASS] backend-compile (4126ms)
[PASS] contract-diff (13593ms)          ← 含红线 23 向量双端同判
[PASS] evidence-gate-test (5310ms)
[PASS] workflow-gate-test (12074ms)
[PASS] frontend-build (2167ms)
[PASS] frontend-test (12010ms)
[PASS] backend-test (18011ms)
[PASS] backend-it (23026ms)             ← WSL PG 17（localhost:5432）
[PASS] acceptance-archives (840ms)
===== verify[commit] PASS (96029ms) =====
```

### CI（GitHub Actions 独立审计层）
- run 42780924503 `verify` **pass** 2m30s（Linux/pwsh + services PG 17）
- PR #5 https://github.com/Liyixi33-89/agent-schema/pull/5 已 MERGED → master 54b6dc5

### Node 工脚本冒烟（编译链路真实产物）
```
smoke-ok  => {"ok":true,"contentHash":"fd9787d7…","artifact":"function e(o){return o.form.getValues()}export{e as onLoad};"}
smoke-bad => {"ok":false,"code":"SECURITY_BLOCKED","errors":[{GLOBAL_DOM 行1:40},{NETWORK_EGRESS 行1:57}]}
```

## 安全链路（三道闸定位）

1. **编辑期**：ScriptPanel 实时 `scanSource`（同 redlines.json 真源）违规阻断提交
2. **保存期**：后端 Node 工进程 acorn AST 扫描（独立进程，Java 不跑 JS 工具链）命中红线 → SECURITY_BLOCKED 422；失败不覆盖 contentHash（线上跑上一版）
3. **运行期**：真实 Worker（Blob 入口 + 产物 import）+ CSP `connect-src 'none'` 产物端点响应头 + terminate 硬中断

## 基线偏离登记

| 项 | 说明 |
|----|------|
| Monaco 未接入 | 编辑期标红以 scanSource 违规列表呈现（项目无 Monaco 依赖）；Monaco+d.ts 随 P2 评估 |
| 单容器 Worker | 无 HPA、并发守卫进程内计数（04BE §2.4 P1 口径）；分布式队列随 P2 |
| with 向量口径 | ESM 严格模式下 with 不可解析 → SYNTAX_ERROR 即拦截（与前端同判口径，测试显式断言该 fallback） |

## 单人模式声明

GitHub 分支保护要求 PR + verify 状态检查；单人模式（批准人数 0）下本 PR 由作者本人创建并合并，CI 为唯一独立审计层。独立 review 待办按 workflow.py singleReviewerMode 登记顺延。
