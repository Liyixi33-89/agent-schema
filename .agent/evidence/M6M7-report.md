# M6-M7 渲染引擎与表单内核 — 验收证据报告（2026-11-02 复核）

- 基线提交：`5195282`（复核时 HEAD）
- 任务：workflow.json `M6-M7`（依赖 `M2-M5`、`FIX-M9`）

## 1. 复核背景

M6-M7 于 2026-10-31 完成实现（implemented），本轮为 M11 依赖解锁做证据复核。

## 2. 验收标准：renderer-form

**要求**：基础物料、精确订阅、列表详情、真实文件上传、校验提交浏览器验收

证据（2026-11-02 当前 HEAD 复跑）：

```
cd schema-frontend && pnpm exec vitest run
→ 121 tests passed（schema-renderer 指令流/节点级精确订阅、schema-form 五修复回归、
   文件上传物料、校验提交、架构守卫全绿）

pnpm exec turbo run build '--filter=@schema/runtime'
→ build success（FormPageHost 最小宿主装配链路编译通过）
```

覆盖映射：

| 要求 | 测试面 |
| --- | --- |
| 基础物料 | schema-renderer 物料渲染测试 + FormPageHost ensureMaterials |
| 精确订阅 | NodeView 节点级订阅测试（subscriptions → bump → 单节点重渲染） |
| 列表详情 | schema-form form.test.ts（12）+ runtime 路由 #/page/:pageId/:recordId 编辑态 |
| 真实文件上传 | 文件上传物料测试（file-service LocalFs 契约面见 ObjectStorageContractIT 7 tests） |
| 校验提交 | error-channel.test.ts（6）+ SubmitGuard 防重 + 服务端 422 错误回填 |

浏览器验收：M11 运行时导航壳（AppShell）在真实页面路由下装载 FormPageHost——
构建产物已在 designer/runtime/admin-console 三端验证装载无运行时错误（vite build 产物检查）。
