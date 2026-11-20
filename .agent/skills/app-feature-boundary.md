---
name: app-feature-boundary
description: 应用内业务边界落地步骤——新代码按 app/features/shared 分层，feature 隔离与展示组件纯净
triggers:
  - 新建页面
  - 新建 feature
  - 应用内目录
  - admin-console
  - designer
  - runtime
  - 跨 feature 引用
version: 1
updated: 2026-11-20
---

# 应用内业务边界（执行步骤）

> 规则真源：`docs/详细前端技术文档/00-前端架构总纲-洋葱分层与设计模式.md` §2.1。
> 本 skill 只写「怎么做」，不重复定义规则。

## 何时使用

在 `schema-frontend/apps/*` 下新增页面/业务模块，或改动既有页面结构时。

## 落地步骤

1. **先定归属**：这段代码是启动/认证/路由/壳 → `app/`；是某个业务域的页面/组件/Hook/API 适配/测试 →
   `features/<业务>/`；被本应用 ≥2 个 feature 真实复用且职责稳定 → `shared/`；跨应用 → `packages/`。
2. **feature 内四件套**：`api.ts`（请求 + 契约解析）、`useXxx.ts`（数据 Hook）、`XxxPage.tsx`（页面编排）、
   `index.ts`（显式导出）。展示组件放 `components/`，只收 props、只回调。
3. **页面只编排**：页面里出现第二个 `req(...)`、大段字段映射、或内联弹窗校验逻辑 → 下沉到 `api.ts` / Hook。
4. **跨 feature 只走 index.ts**：`import { X } from '../other-feature'`；禁止 `'../other-feature/internal/x'`。
5. **展示组件不请求**：`components/` 下不得 import `../api`；数据与 `onRetry` 等回调由页面注入。
6. **Hook 抽取判据**：需要单测、被复用、或含取消/竞态/轮询等生命周期 → 抽 Hook；一次性简单逻辑留原处。
7. **旧代码逐批迁移**：不整仓搬目录；新代码先遵守，触及旧模块时顺手收敛（一次一个 feature）。

## 反模式

- 页面里堆 5 个 `req()` + 字段转换 + 弹窗 → 无法单测、状态散落。
- feature A 直接 `import '../b/internal/helper'` → 改 B 内部实现即打断 A（CI 会拦）。
- 展示组件自己 `useEffect` 发请求 → 无法在 Storybook/测试中独立渲染。
- 为「整齐」把一次性逻辑抽成 Hook → 增加间接层，无复用收益。

## 验证方式

`pnpm architecture`（dependency-cruiser）零违规；`tests/architecture.test.ts` 正负例全绿；
`pnpm typecheck` 通过。