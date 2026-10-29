---
spec_id: 001-schema-protocol-foundation
status: done
milestone: M1                # 依赖图 §3.2 Schema 协议层（关键路径首段）；M1.6 冻结评审 2026-10-29 通过
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
- 迁移函数的真实历史版本编写（当前 LATEST=1，管线空转即可）
- 后端 JSON Schema 校验器/DTO 镜像的**运行时消费方**（02BE 保存链路，随 M2 落地）——本期后端交付以契约测试形态存在（EnumContractTest/SchemaContractTest/ExprVectorTest/ProtocolDtoTest 四组测试消费前端共享真源），M1.4 范围内的镜像类与校验器本体已随清尾批次交付

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

- [x] T1 包骨架 + tsconfig strict + Vitest 就绪（零依赖断言）
- [x] T2 类型体系 + zod schema（含 LayoutNode 递归 lazy；枚举常量数组真源化，types.ts 直接引用）
- [x] T3 ExprEngine 白名单函数全集（15 函数，`functions.json` 真源 + 编译期白名单拦截）
- [x] T4 步数上限 + 类型静态推断报错（EvalBudgetError / 类型不匹配 EvalError）
- [x] T5 迁移管线 + FutureSchemaVersionError（只读侧克隆，不回写存储）
- [x] T6 契约导出脚本（enums.json + schema.json + schema-fixtures.json 三产物；zod 与运行时校验器双定义同断言，Page/Model 双校验器）
- [x] T7 文档 01 §7 单元测试硬性要求全绿（红线语法拒绝含行号列号 / 预算触发 / dependsOn 嵌套提取）
- [x] T8 后端契约消费四组测试落地（EnumContractTest 枚举比对 / ExprVectorTest 向量执行 / SchemaContractTest 共享样本真实校验 / ProtocolDtoTest DTO 镜像往返）

## 5. Acceptance

- [x] A1 `verify -Level commit` 通过（contract-diff 门禁已点亮：前端导出 → 后端 EnumContractTest/SchemaContractTest）
- [x] A2 `schema-protocol` 运行时依赖 = 0（zod 工具链均在 devDependencies，类型/测试豁免口径）
- [x] A3 文档 01 §7 全部用例通过：红线语法拒绝（含行号列号）、EvalBudgetError、字段缺失设计态阻断（FieldMissingError）、迁移闭环
- [x] A4 `functions.json` 存在且被 ExprEngine 消费（Vitest 断言 FUNCTION_NAMES 与文件一致；后端 JUnit 同款断言）
- [x] A5 契约导出物落 `contract/` 且可被 CI diff 校验（enums.json + schema.json + schema-fixtures.json + expr-test-vectors.json 均有双端消费测试；共享样本由前端 Vitest 与后端 SchemaContractTest 真实执行同一份文件）
- [x] A6 DTO 镜像与前端 types.ts 字段同源（ProtocolDtos record + FieldType 按 code 序列化适配器，往返无损经结构校验断言）

## 6. 验证步骤

```text
1. pwsh scripts/verify.ps1 -Level commit
2. cd schema-frontend && pnpm --filter schema-protocol test
3. 观察输出：全部用例绿；A2/A4 断言用例在列
```

## 7. 沉淀记录

- **双端向量执行闭环（M1.5）**：`contract/expr-test-vectors.json` 为唯一真源，前端 Vitest（vectors.test.ts）与后端 JUnit（ExprVectorTest）跑同一份文件，逐条断言结果值/错误码；「一边抛异常一边返回默认值」即 FAIL——01 篇 §5.2 执行器契约的落地形态。
- **后端求值器选型注记**：采用与前端同构的递归下降求值器（ExprEngine.java，约 400 行）而非 Aviator 内核——Aviator 语法面宽于 L1 白名单，受限模式逐项裁剪成本高于直接同构实现；Aviator 依赖保留给流程引擎条件分支（05BE §2.2 Flowable conditionExpression），届时函数注册表从同一 functions.json 生成。该决策已写入评审稿 §5 实现注记。
- **双定义同断言模式**：export-schema.ts 中 zod schema 与运行时校验器（validate.ts）对 6 组 fixture 判定必须一致才允许导出——防止「zod 定义与实际校验逻辑漂移」，此为结构 diff 的前置防线（单靠 diff 两份生成物无法发现两侧同错）。
- **PS5.1 BOM 坑复发一次**：replace_in_file 编辑 verify.ps1 后 BOM 被剥，中文注释 GBK 乱码致解析失败——已按 AGENTS.md §10 复查前 3 字节恢复；后续编辑 .ps1 必须走「UTF8 读→UTF8 BOM 写」文件通道。
- **双端同判三层落地（2026-10-29 清尾批次）**：共享样本 `schema-fixtures.json` 同时被 ① 前端运行时校验器（Vitest schema-contract.test.ts）② 前端 zod 定义（导出器双判 + Vitest parity）③ 后端 SchemaValidator（SchemaContractTest）真实执行——三层判定必须全部等于样本声明值。「只比对判定表」的弱形态已废弃。
- **Gson 枚举镜像坑**：FieldType 等 code 型枚举，Gson 默认按 name() 序列化（NUMBER ≠ number）——必须同时注册序列化（写 code）与反序列化（读 code 匹配）两端适配器，否则 DTO 往返样本直接校验失败。
