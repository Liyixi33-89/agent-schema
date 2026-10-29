---
spec_id: 001-schema-protocol-foundation
status: active
milestone: M1                # 依赖图 §3.2 Schema 协议层（关键路径首段）
created: 2026-10-26
last_verified_at: 2026-10-29
owner: 待定
---

# Spec · Schema 协议层奠基（P1 首任务）

## 1. 背景与目标

协议层是全平台地基（前端文档 01 / 后端文档 01 的共同上游）。PRD §6.1/§6.2 决策要求字段状态机、表达式白名单、双端契约镜像从第一天成立。不做则后续所有模块（渲染/表单/建模器/数据引擎）没有可依赖的稳定内核。

## 2. 范围声明

**做**：

- `schema-frontend/packages/schema-protocol` 包骨架（零运行时依赖）
- 类型体系：ModelSchema/FieldSchema/PageSchema/LayoutNode/ExpressionBinding（前端文档 01 §2）
- zod 校验器 + JSON Pointer 错误路径
- ExprEngine：Tokenizer→Pratt Parser→AST→Evaluator，白名单 `functions.json`，1000 步上限
- `extractDepends` 静态依赖提取
- schemaVersion 迁移管线骨架（migrate + FutureSchemaVersionError）
- `zod-to-json-schema` 导出脚本 → `contract/` 目录（供后端 diff）

**不做**：

- React 渲染集成（spec-002，渲染引擎任务）
- 后端 `schema-protocol-java` 实现（后端独立 spec；本期只交付前端导出的契约文件）
- 迁移函数的真实历史版本编写（当前 LATEST=1，管线空转即可）

## 3. 接口契约

```ts
// 包公共导出（index.ts）。签名冻结，改动需回本节更新
export const LATEST_SCHEMA_VERSION: number;
export function validate(schema: unknown): { ok: true; data: PageSchema | ModelSchema } | { ok: false; errors: JsonPointerError[] };
export function migrate(schema: AnySchema): AnySchema;            // 抛 FutureSchemaVersionError
export const ExprEngine: {
  compile(source: string): { ast: ExprNode } | { error: CompileError };
  evaluate(ast: ExprNode, scope: Record<string, unknown>): { value: unknown } | { error: EvalError };
  extractDepends(ast: ExprNode): string[];
};
```

## 4. Tasks

- [ ] T1 包骨架 + tsconfig strict + Vitest 就绪（零依赖断言）
- [ ] T2 类型体系 + zod schema（含 LayoutNode 递归 lazy）
- [ ] T3 ExprEngine 白名单函数全集（约 20 个，以 `functions.json` 为真源）
- [ ] T4 步数上限 + 类型静态推断报错
- [ ] T5 迁移管线 + FutureSchemaVersionError
- [ ] T6 契约导出脚本（zod → json-schema → `contract/`）
- [ ] T7 文档 01 §7 单元测试硬性要求全绿

## 5. Acceptance

- [ ] A1 `verify -Level commit` 通过（含本 spec 防腐检查项）
- [ ] A2 `schema-protocol` 依赖数 = 0（package.json dependencies 为空，devDependencies 仅类型/测试）
- [ ] A3 文档 01 §7 全部用例通过：红线语法拒绝（含行号列号）、EvalBudgetError、DELETED 字段设计态阻断、迁移闭环
- [ ] A4 `functions.json` 存在且被 ExprEngine 消费（不是硬编码白名单）
- [ ] A5 契约导出物落 `contract/` 且可被 CI diff 校验

## 6. 验证步骤

```text
1. pwsh scripts/verify.ps1 -Level commit
2. cd schema-frontend && pnpm --filter schema-protocol test
3. 观察输出：全部用例绿；A2/A4 断言用例在列
```

## 7. 沉淀记录

（结项回填）
