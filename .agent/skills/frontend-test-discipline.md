---
name: frontend-test-discipline
description: 前端测试纪律——分层归属（Unit/Contract/E2E）、状态三态必测、Worker 隔离必须真实浏览器
triggers:
  - 写测试
  - vitest
  - playwright
  - 测试覆盖率
  - 快照测试
version: 1
updated: 2026-10-28
---

# 前端测试纪律

## 何时使用

为任何前端代码写测试、修复测试失败、或讨论「这段代码要不要测」时。测试体系总纲见 `docs/详细测试技术文档/00`。

## 规则/经验

1. **层级归属先定位**（00 篇 §2）：纯函数/zod 校验/表达式 → Unit（Vitest，禁 IO）；双端共享物 → Contract（向量执行器）；跨模块链路 → E2E（Playwright）。**用例只下放不上收**——能在 Unit 断言的不写集成拖慢反馈。
2. **组件测试必测三态 + 错误**：loading / 空数据 / 正常 / 请求失败（mock error）。只测正常态 = 半个测试。AntD 组件用 `@testing-library/react` 查询语义角色（`getByRole('button')`），禁按 class 名断言内部实现。
3. **Worker/L2 测试铁律**（08FE §3 红线）：隔离/terminate/CSP 断言**必须真实浏览器**（Playwright）——jsdom 模拟不了 Worker CSP 与 terminate 语义；环境断言限定能力面（DOM 不可达/token 不进 Worker/出口三层），不断言「全局对象不可达」。
4. **Mock 边界**：单测 Mock 后端用契约样本（`contract/fixtures/` 种子公司），禁手造与真实契约不符的假数据；集成/E2E 层**必须走真实登录流程**（伪造租户头是被测行为本身，Mock 掉等于没测，00 篇 §6）。
5. **快照测试使用域**：渲染引擎对种子公司的输出快照（回归护栏）✔；整页组件大树快照（脆弱噪音）✘——快照前先问「diff 了能不能读懂」。
6. **时钟注入**：涉日期/超时的测试注入固定时钟（表达式向量已定版注入时钟语义）；禁依赖真实时间的 flaky 测试。
7. **门禁挂接**（00 篇 §3）：差异测试进 quick；受影响模块全量单测 + 契约 diff 进 commit；E2E 冒烟（预览→发布→运行链路）进 ci。**临时注释测试代码视为违规**，SKIP 走 00 篇 §7 登记表。

## 反模式（踩过的坑）

- 测试里 `await waitFor(() => {})` 泛等待消 flaky → 掩盖真实竞态；断言驱动等待（findBy*）。
- mock 返回 `{code: 0}` 万能假数据 → 契约变更测试不报警；用 OpenAPI 类型约束 mock。
- 在 jsdom 里「测」Worker 隔离 → 全绿但线上环境断言根本没执行过（G7 曾因此差点放过假验收）。
- 追求覆盖率数字写 getter/setter 测试 → 覆盖率好看、门禁不过；以关键不变量断言为准（00 篇 §11）。

## 验证方式

`vitest run` 受影响模块全绿；契约向量执行器零差异；Playwright L2 用例在真实 Chromium 执行记录归档（EV 编号，00 篇 §8.2）。
