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
- 后端 JDK21 定版（2026-10-28 决策）：toolchain 锁 21、CI setup-java 升 21（已改 verify.yml）；**预览特性一律不开**——租户上下文存储按 03BE §2.1 接口化（TenantContextHolder，ThreadLocal 默认实现），ScopedValue 转正式后再切换实现
- 前端 `schema-frontend`：pnpm workspace + Turborepo 骨架，apps/{designer,runtime,admin-console} 与 packages 按总纲 §2 分层表建空包；dependency-cruiser 规则先注册
- CI 三档真实化：verify.ps1 的 frontend-tsc/backend-compile/frontend-build/frontend-test/backend-test 五个 [SKIP] 全部转 [PASS]
- **安全地基（2026-10-28 攻防评审补入）**：
  - CSP Report-Only 响应头挂载（策略见 04BE §2.5 / 06FE §5——M0 不转强制，M6 渲染引擎完成时切换；Report-Only 违规上报通道接通）
  - 附加安全响应头基线：`X-Content-Type-Options`/`Referrer-Policy`/API `Cache-Control: no-store`
  - 前端危险 API lint 禁令骨架：`dangerouslySetInnerHTML`/`eval`/`new Function` 白名单模式（规则实现随 M6 物料落地，M0 只挂规则位）
  - 认证与 CSRF 策略定版落码位：Bearer Header + Origin 校验中间件接口（03BE §4——实现随 M3.1，M0 只锁契约）

**不做**：

- 任何业务逻辑（元数据/数据引擎/协议类型都是后续 spec）
- ArchUnit/dependency-cruiser 的具体规则编写（M0 只挂框架，规则随各模块首个实现 spec 落地）
- contract-diff（属 M1.5——契约产物 schema-protocol/contract/ 在 M1 才存在，M0 无从 diff；验收明确排除，不算 SKIP 失败）
- E2E（Playwright 属联调阶段；M0 无页面可测，ci 级 frontend-e2e 保持 [SKIP] 属合法降级——分阶段说明见 11FE §4 与 AGENTS.md §验证管线）

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

- [ ] A1 `verify -Level commit` 全步 [PASS]；仅允许两类合法降级——contract-diff [SKIP]（M1.5 前无契约产物）、frontend-e2e [SKIP]（ci 级专属，commit 级不跑且 M0 无页面）；其余任何 [SKIP]/[FAIL] 均不通过
- [ ] A2 后端模块间依赖仅经 `*-api`：ArchUnit 空规则框架就位 + **至少 1 条真实规则反向验证**（构造一个违规依赖样本证明会 FAIL——空规则挂而不知失效即腐烂）
- [ ] A3 前端跨包 import 走包名：dependency-cruiser 占位规则可跑 + 同上反向验证（违规样本被拦截）
- [x] A4 GitHub Actions 在 push 时真实执行（2026-10-29 用户在 Actions 页面确认成功；JDK21 镜像就位。运行链接及对应 SHA 尚未登记；本地未提交的新增测试不包含在该远端成功记录内）
- [ ] A5 Flyway 幂等：重复启动 checksum 通过（T2 同源验收）

## 6. 验证步骤

```text
1. pwsh scripts/verify.ps1 -Level commit      → 期望全 [PASS]
2. git push 后查看 Actions 绿勾
3. mvn -q compile 与 pnpm build 本地独立复跑
```

## 7. 沉淀记录

（结项回填）
