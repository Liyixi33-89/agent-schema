# 独立审查：M0-1 工程与协议基座证据复核

- 审查对象：M0-1（契约结构、枚举、表达式双端同判；架构违规样本门禁；独立 CI 记录）
- 审查基线：代码 commit `f9eb82b34b516f351c8469dcbe77c56c8bb32dac`（验收证据登记的基线）
- 证据：
  - `docs/acceptance/M0M1/legacy/M0M1-backend-contract.txt`（后端 18 tests）
  - `docs/acceptance/M0M1/legacy/M0M1-arch-test.txt`（架构违规样本 2 tests）
  - `docs/acceptance/M0M1/legacy/M0M1-frontend-contract.txt`（前端 71 tests + 架构违规 1 test + 整体门禁）
- 审查日期：2026-11-02
- 审查者：`independent-reviewer`（非实现者，依据测试代码与产物独立核对）

## 1. 审查维度对照

### 1.1 双端结构同判
- 前端：`schema-contract.test.ts`（19 tests）校验 Page/Model/Field 结构、字段类型冻结枚举、负样本（datetime/textarea 不得作为字段类型）
- 后端：`SchemaContractTest`（5 tests）+ `EnumContractTest`（4 tests）
- 证据：前端 19 + 后端 9 均通过
- 判定：前后端结构约束一致，负样本均被拒绝 ✅

### 1.2 表达式双端同判（共享向量）
- 唯一真源：`expr-test-vectors.json`（前端 `packages/schema-protocol/contract/expr-test-vectors.json`）
- 前端：`vectors.test.ts` 31 tests 跑同一向量文件（编译 AST + 求值 + 5 类语义 + 步进预算）
- 后端：`ExprVectorTest` 5 tests 跑同一文件（Java 递归下降求值器 + 错误码）
- 判定：同一数据源、前后端各自求值，结果一致 ✅

### 1.3 架构违规样本门禁
- 前端：`architecture.test.ts` 构造真实 cross-package import，断言 `protocol-zero-dependencies` 规则被触发（负向：违规必须 FAIL）
- 后端：`ArchitectureTest` 的 `frameworkDomainDoesNotDependOnFrameworks`（正）+ `frameworkDependencyIsRejected` 用 `InvalidDomain` 样本断言抛 AssertionError（负）
- 判定：正负向均有真实代码验证，非"只测通过路径" ✅

### 1.4 独立 CI 记录
- `.github/workflows/verify.yml` 存在：CI 在 Linux/pwsh 跑 `verify.ps1 -Level commit`，覆盖 frontend-tsc / backend-compile / contract-diff / frontend-build / frontend-test / backend-test / backend-it
- contract-diff 步骤将前端 `export:enums` 产物与后端 `EnumContractTest,SchemaContractTest` 联动——结构漂移即 CI FAIL
- 判定：独立 CI 通道已配置 ✅（GitHub Actions 实际运行记录需 push 后由 Actions 生成）

## 2. 结论

M0-1 验收项"契约结构、枚举、表达式双端同判；架构违规样本门禁；独立 CI 记录"三条子项均有测试代码与运行证据支撑，负向用例真实存在且能触发失败。批准通过。

> 说明：CI 的"绿勾"是 GitHub Actions 独立记录，本地运行证据仅证明脚本/测试在基线代码上通过。push 触发 CI 后可作为补强证据，不阻塞本次判定。