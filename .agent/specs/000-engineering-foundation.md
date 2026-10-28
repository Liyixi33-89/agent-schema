---
spec_id: 000-engineering-foundation
status: draft
milestone: M0                # 依赖图 §3.1 工程地基（串行起点）
created: 2026-10-28
last_verified_at: null
owner: 待定
---

# Spec · 工程地基（M0 · 串行起点）

## 1. 背景与目标

依赖图 §3.1：一切任务开工前先有可验证的工程骨架——后端 Maven 多模块 + Flyway 基线、前端 pnpm monorepo、CI 三级管线从「优雅降级」转为「真实编译/测试门禁」。不做则 M1 协议层没有落地位置，verify 的 SKIP 永远不消失。

## 2. 范围声明

**做**：

- 后端 `schema-platform`：Maven 多模块骨架（platform-common + 七业务模块的空壳 + bootstrap），模块目录即 00BE §3 结构；ArchUnit 依赖规则先注册为空跑
- 后端 Flyway 基线：bootstrap 模块挂 Flyway，`V1__platform_baseline.sql`（空基线，仅验证链路）
- 前端 `schema-frontend`：pnpm workspace + Turborepo 骨架，apps/{designer,runtime,admin-console} 与 packages 按总纲 §2 分层表建空包；dependency-cruiser 规则先注册
- CI 三档真实化：verify.ps1 的 frontend-tsc/backend-compile/frontend-build/frontend-test/backend-test 五个 [SKIP] 全部转 [PASS]

**不做**：

- 任何业务逻辑（元数据/数据引擎/协议类型都是后续 spec）
- ArchUnit/dependency-cruiser 的具体规则编写（M0 只挂框架，规则随各模块首个实现 spec 落地）

## 3. 接口契约

```text
目录结构契约（AGENTS.md §3 规划骨架即本 spec 的验收形态）：
schema-platform/
├── platform-common/
├── metadata-module/  data-module/  page-module/  flow-module/
│   iam-module/  integration-module/  metering-module/
│   （各模块内 command-api/query-api/application/domain/infrastructure 按 00BE §3）
└── bootstrap/        （含 Flyway 配置）
schema-frontend/
├── apps/designer  apps/runtime  apps/admin-console
└── packages/schema-protocol  …（按前端总纲 §2 分层表全量建包，空实现）
```

## 4. Tasks

- [ ] T1 Maven 多模块骨架编译通过（`mvn -q compile`）
- [ ] T2 Flyway 基线挂通（bootstrap 启动 migrate 成功，重复启动 checksum 通过）
- [ ] T3 pnpm workspace + Turborepo 骨架（`pnpm build` 空 packages 通过）
- [ ] T4 全量包结构落位并与前端总纲 §2 分层表逐一核对
- [ ] T5 CI 五个 [SKIP] 转 [PASS] 并在 Actions 留绿记录

## 5. Acceptance

- [ ] A1 `verify -Level commit` 全步 [PASS] 无 [SKIP]
- [ ] A2 后端模块间依赖仅经 `*-api`（ArchUnit 空规则框架就位，占位用例可跑）
- [ ] A3 前端跨包 import 走包名（dependency-cruiser 占位规则可跑）
- [ ] A4 GitHub Actions 在 push 时真实执行（verify.yml 分支触发已修复的实证）

## 6. 验证步骤

```text
1. pwsh scripts/verify.ps1 -Level commit      → 期望全 [PASS]
2. git push 后查看 Actions 绿勾
3. mvn -q compile 与 pnpm build 本地独立复跑
```

## 7. 沉淀记录

（结项回填）
