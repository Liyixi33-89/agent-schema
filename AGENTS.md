# AGENTS.md — Schema 低代码平台 · Agent 工作规则

> 所有 Agent 会话**先读本文件**。本文件是 L1 常驻上下文，预算 ≤200 行（超限即违反本体系）。
> 任务规格在 `.agent/specs/`；经验固化在 `.agent/skills/`；体系总览见 `.agent/README.md`。
> 本文件只写「一个月后仍然成立」的内容——实时状态（进度/行号/TODO）一律现场读代码。

## 1. 项目定位（一句话）

面向企业中后台的低代码搭建平台：以 Schema 协议为核心，前端 React 洋葱分层 + 后端 Java DDD 模块化单体，双轨渲染（动态解析/编译产物），四级逃生舱（L1-L4）。

## 2. 技术栈（不可擅改，改动需人类授权）

| 端 | 栈 |
|---|---|
| 前端 | React 18 + TypeScript + Vite + pnpm workspace + Turborepo；Zustand + TanStack Query；zod；@dnd-kit；React Flow；Monaco |
| 后端 | Java + Spring Boot 3 + PostgreSQL(JSONB) + Redis + Kafka + Flowable；Flyway；模块化单体（Maven 多 module） |
| 契约 | Schema 协议双端镜像：前端 zod ↔ 后端 `schema-protocol-java`；API 类型由 OpenAPI 自动生成 |

## 3. 目录结构（规划骨架）

```
schema/
├── AGENTS.md  docs/               # docs = 评审定稿基线（见权限分级）
├── .agent/{README,specs,skills,metrics}
├── scripts/verify.ps1             # 三级验证管线
├── .github/workflows/verify.yml   # CI 独立审计
├── schema-frontend/               # 前端 monorepo：apps/{designer,runtime,admin-console}
│   └── packages/                  # schema-protocol(零依赖)→引擎层→request/auth/usage-sdk→shared-ui
└── schema-platform/               # 后端：platform-common + {metadata,data,page,flow,iam,
                                   #   integration,metering}-module(*-api 对外) + bootstrap
```

## 4. 必读文档路由（按任务域精准读，禁止整仓投喂）

| 任务域 | 先读 |
|---|---|
| 任何前端任务 | `docs/详细前端技术文档/00-前端架构总纲-洋葱分层与设计模式.md` |
| 前端模块 | `…前端技术文档/01~16`（按号取用，目录见 `docs/README.md`） |
| 任何后端任务 | `docs/详细技术文档/00-后端架构总纲-DDD分层与战术设计.md` |
| 对应服务域 | `docs/详细技术文档/01~14`（按号取用） |
| 协议改动 | `docs/Schema核心数据协议评审稿.md`（先查真源位置再改） |
| 排期/任务拆分 | `docs/MVP开发任务依赖顺序图.md`（spec 编号与 M 任务对应） |
| 需求口径 | `docs/详细PRD/01~10`；顶层决策 `docs/PRD-*.md` §6~§8 |

## 5. 上下文预算

| 内容 | 加载时机 | 预算 |
|---|---|---|
| 本文件 | 每会话常驻 | ≤200 行 |
| 相关 spec | 按需 1-2 份 | 单份 ≤500 行 |
| 实时状态（依赖树/路由/Schema/进度） | 工具现场读取 | **禁止写进任何文档** |
| 代码本体 | outline → 局部读 | 禁止整仓投喂 |

## 6. AI 权限分级（结构化安全边界，不靠口头提醒）

| 级别 | 内容 | 规则 |
|---|---|---|
| 🔴 禁止 | `docs/` 基线、`sql/*.sql`、`package.json`/`pom.xml` 依赖变更、删除操作、生产/部署配置 | 需人类明确授权 |
| 🟡 谨慎 | `schema-frontend/packages|apps`、`schema-platform/*` 常规编码；skills 追加 | 正常修改，保持风格 |
| 🟢 自由 | 新增组件/hook/页面/测试/工具脚本等增量文件 | 遵循本文件约定即可 |
| ⚠️ 永久排除 | 密钥、token、真实用户数据 | 不得进入任何文件/日志/prompt |

## 7. 硬约束（编码红线，违反即返工）

**前端**：
1. 洋葱单向依赖：L4→L3→L2→L1；`schema-protocol` 依赖数恒为 0；跨包 import 必须走包名（禁相对路径跨包）
2. 禁上帝 Context：渲染/表单的字段级状态走 valtio 原子化订阅；Zustand 仅用于设计器全局 UI 状态；服务端数据走 TanStack Query
3. 禁 `eval`/`new Function`：表达式一律走 ExprEngine（白名单 + 1000 步上限）
4. 禁手写 API DTO：类型由 OpenAPI 生成（`api-types.gen.ts`）；请求统一走 request-sdk（禁裸 fetch）
5. 属性面板必须由 propsSchema 自动生成（禁手写属性表单）；受控组件必须实现 value/onChange 契约
6. 运行时产物不得包含设计器代码（双入口条件编译，CI bundle 断言）

**后端**：
1. 模块间只依赖对方 `*-api` 包（ArchUnit 门禁）；领域层无 Spring/MyBatis 注解依赖
2. 业务不变式收口聚合根（如字段状态机），Service 不得绕过；事务边界 = 单聚合，跨聚合走领域事件 + Outbox
3. 禁跨模块表 join（为拆分保留切口）；DDL 铁律：永不 `DROP COLUMN`，字段只做逻辑删除
4. 行级/字段级权限只在 data-module 查询管线注入，任何调用方不得绕过
5. Java 进程不运行 JS 工具链（编译走 Node Worker）；客户代码只在沙箱执行器运行

**契约**：`functions.json`（表达式白名单）、`redlines.json`（脚本红线）、OpenAPI、zod→json-schema 四件双端共用；任一改动必须双端同步 + CI diff 通过。

## 8. 验证管线（AI 改动与人写代码同一条管线，无豁免）

```text
quick   —— 文档防腐检查 + 前端 tsc + 后端 compile（存在才跑）      每次改动后必跑
commit  —— quick + 前端 build + 后端 test                        提交前
ci      —— commit + E2E                                         联调/交付前；CI 在 push/PR 时跑 commit 级
```

- 脚本：`scripts/verify.ps1 -Level quick|commit|ci`（跨平台，CI 用 pwsh 跑同一份）
- 结果自动追加 `.agent/metrics/verify-log.jsonl`（度量数据不入 git）
- **红线：验证失败静默重试不得超过 2 次**——必须换思路或上报，禁止在错误方向烧 token
- 「验证通过」是自我报告；GitHub Actions 绿勾才是独立审计

## 9. 沉淀纪律（回流是义务，不是可选项）

- 每次返工/验证失败，若原因可复用 → **当场**更新对应 skill 或 spec，不依赖「下次记得」
- 「重复交代指数」：同一背景第二次向 AI 粘贴时，就是固化 skill 的时机
- skill 格式对齐 Anthropic Agent Skills 规范（YAML frontmatter + 触发关键词）；spec 对齐三件套（spec/tasks/acceptance）
- spec 是活文档：结项后 `status: active → done`；范围与交付不符时当场修正

## 10. 文档防腐（过期信息比没有信息更危险）

- 本文件与 `.agent/specs|skills` 禁止出现：任务进度、具体行号、临时 TODO、实时配置值
- 判断标准：**这句话一个月后还成立吗？不成立就删**
- 检查器也要被检查：防腐检查脚本本身纳入季度人工抽查（硬编码检查项 = 未来漏检点）
- AI 工具是环境的一部分：编辑含 BOM 的 `.ps1` 后必须复查前 3 字节；长内容/含特殊字符内容走文件通道，不经过 LLM 复述
