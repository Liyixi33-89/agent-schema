# 详细测试技术文档 01 · Schema 协议与双端契约测试

> 版本：v1.0 | 日期：2026-10-28 | 定位：协议层（M1）与契约 CI（M1.5）的**测试设计真源**——双端镜像校验、枚举比对、表达式语义向量、版本迁移、API 错误码
> 输入来源：前端 01FE §2-7（类型体系/zod/表达式/迁移/契约同步）、后端技术方案 §3.1（schema-protocol-java）、后端 10BE §5（表达式双端一致性）+ §A.3（错误码表）、《Schema 核心数据协议评审稿》§7（遗留行动项）
> 前置阅读：00 篇 §2（分层）、§8（用例追溯格式）

---

## 1. 被测对象与风险模型

协议层是全平台地基（依赖图 M1，协议冻结门 M1.6 的对象）。风险不在「某个函数写错」，而在**双端各自演化导致的语义漂移**——评审稿 §7 已发现过 2 处真实漂移（aggregate 协议不一致、FilterNode 拼写分裂），证明人工比对不可持续。

| 风险 | 后果 | 本篇对应章节 |
|---|---|---|
| TS 类型与 Java DTO 结构漂移 | 前端提交的 Schema 后端拒收或静默截断 | §3 结构 diff |
| 枚举值集合漂移（字段类型/过滤操作符） | 合法值单端存在，跨端不可用 | §4 枚举专项 |
| 同名表达式函数语义不同 | 流程分支双端判定相反（业务错误，非崩溃） | §5 测试向量 |
| 递归配置无深度上限 | 恶意/事故深层嵌套拖垮渲染与求值 | §3.4 |
| 迁移管线非幂等 | 读取侧迁移重复执行产生脏数据 | §6 |
| 错误码双端不一致 | 前端提示与后端语义错位 | §7 |

## 2. 测试资产清单（M1.5 交付物）

| 资产 | 位置 | 双端消费方式 | 唯一真源 |
|---|---|---|---|
| `functions.json` | `packages/schema-protocol/src/expr/` | 前端直接 import；后端生成 Aviator 注册表（生成物入库，CI diff 为空） | 前端 01FE §4 |
| `expr-test-vectors.json` | 同上 | 前端 Vitest 执行器 + 后端 JUnit 执行器，双端跑全量断言一致 | 前端 01FE §4（2026-10-28 定版） |
| `schema.json`（zod-to-json-schema 导出） | `contract/export/` | 后端 schema-protocol-java 校验规则文件比对 | 前端 01FE §6 |
| `enums.json`（字段类型/过滤操作符/动作类型枚举集合导出） | `contract/export/` | 后端枚举类比对（**评审稿 §7.3 遗留项，本篇补齐测试设计**） | 本篇 §4 首创 |
| 种子公司 fixtures | `contract/fixtures/` | 契约校验、E2E、性能压测共用 | 00 篇 §4 |
| `openapi.json` | 后端动态导出 | `openapi-typescript` 生成 `api-types.gen.ts` | 后端 10BE §7.2 |

## 3. Schema 结构校验测试

### 3.1 双端校验镜像矩阵（M1.1 + M1.4 联测）

**用例组 C-STRUCT**（层级：L-Contract；门禁：commit/ci + 协议冻结门；自动化：Vitest + JUnit 参数化跑同一批 fixture）

| 用例 | 输入（fixture） | 预期（双端必须同判） | 证据 |
|---|---|---|---|
| C-STRUCT-01 最小合法 ModelSchema | 只含必填字段 | 双端通过 | Vitest/JUnit 报告 |
| C-STRUCT-02 全量合法种子公司 | 12 种字段类型 + 全部配置项 | 双端通过 | 同上 |
| C-STRUCT-03 缺 schemaVersion | 必填缺失 | 双端拒，错误码一致（VALIDATION_ERROR 子码） | 同上 |
| C-STRUCT-04 非法字段类型 `"textarea"` | textarea 已定版为控件配置不进枚举 | 双端拒且错误信息含合法枚举列表 | 同上 |
| C-STRUCT-05 非法过滤操作符 `"IsNull"`（大写） | `isnull` 全小写定版 | 双端拒 | 同上 |
| C-STRUCT-06 PageSchema 递归 LayoutNode 深度 51 | 深度上限 50 | 双端拒（超限错误） | 同上 |
| C-STRUCT-07 ActionBinding 数组绑定 | 布尔/数值/动作数组三类绑定 | 双端通过且类型区分正确 | 同上 |
| C-STRUCT-08 PropValue 非法绑定混入普通对象 | `{type:'binding'}` 缺字段 | 双端拒——**验证 JSON 兜底不会放过非法绑定**（前端 zod discriminator 校验） | 同上 |
| C-STRUCT-09 AggregateRequest 合法结构 | measures[] + group + timeBucket | 双端通过（评审稿 §7 #2 修复项回归） | 同上 |
| C-STRUCT-10 FlowSchema 最小流程 | start→approve→end | 双端通过（10FE §2.1 定义） | 同上 |

**断言铁律**：矩阵中每条用例的判定结果（通过/拒绝+错误码）必须**逐条双端相等**——「前端拒、后端收」或反之即 FAIL，这正是评审稿发现的 aggregate 漂移模式。

### 3.2 zod → JSON Schema → Java 校验规则 diff（C-DIFF）

- 流程：前端 `zod-to-json-schema` 导出 → `contract/export/schema.json` → 后端加载生成校验规则文件 → CI 比对两份生成物；
- **已知局限显式化**（01FE §6 已声明）：结构 diff 只证明「两边结构描述一致」，不证明「枚举值集合一致」——枚举专项见 §4；
- 用例 C-DIFF-01：人为在 TS 侧加一个字段不更新导出 → diff FAIL（反向验证 diff 机制本身有效——spec-000 要求「违规样本必须 FAIL」）。

### 3.3 schemaVersion 迁移管线测试（M1.3）

**用例组 C-MIGR**（层级：L-Unit；门禁：commit）

| 用例 | 输入 | 预期 |
|---|---|---|
| C-MIGR-01 | v1 合法样本 | 迁移到 LATEST，zod 终验通过 |
| C-MIGR-02 | v1 样本连跑 migrate 两次 | 输出幂等（deepEqual） |
| C-MIGR-03 | schemaVersion = LATEST+1 | 抛 FutureSchemaVersionError（运行时防缓存投毒/降级部署） |
| C-MIGR-04 | 历史真实样本快照（每版本一份） | 迁移后与预期快照逐字段一致（01FE §5 要求迁移配真实样本测试） |
| C-MIGR-05 | 迁移过程不回写存储 | 迁移只发生在读取侧——断言原对象未被 mutate（后端保留原始版本承诺） |

### 3.4 递归与深度防护

- LayoutNode 递归深度上限 50（C-STRUCT-06 已覆盖结构层）；
- 表达式 AST 步数上限 1000 抛 EvalBudgetError（01FE §4）——构造深嵌套表达式触发，属 §5 向量之外的单元硬性项；
- JSON 序列化深度：请求体序列化器对超深 JSON 抛出明确错误而非栈溢出（后端 Jackson 层用例，防恶意请求）。

## 4. 枚举值集合专项比对（评审稿 §7.3 遗留项闭环）

**这是文档期已知唯一待办，本节将其测试设计定版，落地在 M1.5。**

### 4.1 被比对枚举清单

| 枚举 | TS 侧真源 | Java 侧真源 | 定版值 |
|---|---|---|---|
| FieldType | 01FE §2 联合类型 | 后端 field_type 枚举 | 12 种（textarea/datetime 不进枚举——控件配置项） |
| FilterNode.op | 01FE §2 | ConditionTree 白名单 | 11 个（含 nin；isnull 全小写） |
| ActionBinding.type | 01FE §2 | 04BE 动作类型 | 与 PRD 02 §4 动作面板对齐 |
| 错误码域前缀 | 07FE 拦截映射 | 10BE §A.3 分域登记表 | 见 §7 |

### 4.2 实现方式

```
contract/export/enums.json  ← 前端构建脚本从 TS 联合类型提取（ts-morph 或手写导出常量文件）
                             ← 后端构建脚本从 Java 枚举类提取
两份生成物 CI diff——任何一侧新增/删除枚举值而另一侧未跟 → FAIL
```

### 4.3 用例

- C-ENUM-01：当前双端枚举提取 diff 为空（存量一致性验证——**M1.5 首次执行时如果 FAIL，说明文档期对齐有漏，立即修而不是豁免**）；
- C-ENUM-02：TS 侧新增 `'geolocation'` 字段类型但不更新 Java → diff FAIL（反向验证）；
- C-ENUM-03：错误码新增子码不登记分域表 → diff FAIL。

## 5. 表达式语义共享测试向量（C-EXPR）

向量真源 `expr-test-vectors.json`，格式 `{source, scope, expect: {value} | {error, code}}`。双端执行器（前端 Vitest / 后端 JUnit）跑全量，**逐条断言结果与错误码一致**。

### 5.1 向量覆盖矩阵（五类语义，01FE §4 定版）

| 类别 | 向量数（≥） | 代表用例 | 锁定语义 |
|---|---|---|---|
| 日期时区 | 15 | `DATE_DIFF('2026-01-02','2026-01-01','DAY')`→1；`DATE_FORMAT(NOW(),'YYYY-MM-DD')` 固定注入时钟下输出 | UTC 存储 + 渲染层本地化（定版） |
| 空值传播 | 12 | `null+1`→null；`CONCAT(null,'a')`→'a'（跳过 null 拼接其余，定版）；`null==''`→false | null 传染规则 |
| 数值精度 | 10 | `ROUND(0.1+0.2,1)`→0.3（half-up 定版，BigDecimal vs toFixed 对齐）；整数溢出边界 | 舍入模式 |
| 短路求值 | 8 | `false&&(1/0)`→false 且无异常；`INCLUDES(f,未定义)` 错误码断言 | 求值顺序与异常语义 |
| 类型转换 | 10 | `'5'>3` compile 期报错（静态推断拦截）；`LENGTH(null)`→0（定版） | 强类型边界（不做隐式转换） |

每类再加 **边界与对抗向量**（≥3 条/类）：超长字符串、NaN 注入、scope 缺失键、步数上限触发。

### 5.2 执行器契约

- 前端执行器：Vitest 内直接调 L1 引擎 evaluate，注入 scope 与固定时钟；
- 后端执行器：JUnit 参数化，Aviator 受限模式同一注入方式；
- **错误码断言双向**：向量标 `{error, code}` 时，双端要么同抛同码，要么同为值——「一边抛异常一边返回默认值」即 FAIL（这正是 INCLUDES 未定义字段的漂移模式）；
- 向量文件变更规则：新增向量随功能 PR 提交；**修改既有向量的期望值 = 协议变更**，需走评审稿 §8 协议冻结流程，不允许静默改。

### 5.3 引用完整性（表达式 vs 元数据）

- C-REF-01：表达式引用 DELETED 字段 → 设计态 FieldMissingError 阻断；运行时降级为安全默认值且上报埋点（01FE §7）——双端行为分别断言；
- C-REF-02：`dependsOn` 提取含嵌套函数体内的字段引用（01FE §7）；
- C-REF-03：函数白名单外的标识符在 compile 期被拒（`eval`/`new Function`/成员链调用，错误含行号列号）。

## 6. API 契约与 DTO 生成测试

- C-API-01：后端 OpenAPI 导出 → `openapi-typescript` 生成 `api-types.gen.ts` → 前端编译期无手写 DTO 逃逸（dependency-cruiser 规则 + grep 禁 `interface.*Dto` 手写）；
- C-API-02：后端发版触发 diff → 与存量 `api-types.gen.ts` 比对 → 差异自动开 PR（10BE §7.2 机制的功能测试）；
- C-API-03：破坏性字段删除（响应体删字段）→ diff 标记 breaking → CI FAIL（防止后端无感破坏前端）；
- C-API-04：分页/排序/过滤通用约定（10BE §A.1）双端一致——请求构造器（07FE SDK）与后端解析器的往返（serialize→parse→deepEqual）测试。

## 7. 错误码契约测试

后端 10BE §A.3 分域登记表是唯一真源。测试：

- C-ERR-01：**枚举比对**——前端 07FE 拦截映射表的错误码集合 ⊆ 后端登记表（前端可少映射不可多映射未知码）；
- C-ERR-02：每个登记错误码至少一条触发用例（集成层真实触发断言 code 与 message 模板）——**禁止只测「返回 4xx」**；
- C-ERR-03：错误响应结构统一 `{code, message, traceId, details?}`（10BE §A.2）——契约测试断言结构而非仅状态码；
- C-ERR-04：安全类错误（越权/租户不符）响应不含资源存在性泄露（403 不变 404 的场景断言——文案与状态码组合审计）。

## 8. 门禁挂接与验收标准（本模块自身）

### 协议冻结门（M1.6）过门条件

- [ ] C-STRUCT 01-10 双端同判全绿
- [ ] C-DIFF 结构 diff 为空且反向验证用例（C-DIFF-01）FAIL 生效
- [ ] C-ENUM 存量一致性（C-ENUM-01）通过——评审稿 §7.3 遗留项在此闭环
- [ ] C-EXPR 全量向量双端执行零差异（≥55 条 + 对抗向量）
- [ ] C-MIGR 01-05 全过（含幂等与快照比对）
- [ ] C-API/C-ERR 基线集通过
- [ ] 上述结果出具 `gate-protocol-report.md` 归档（00 篇 §8.3 格式），证据物编号 EV-M1-*

### 单元测试硬性要求（协议层）

- [ ] zod 全类型校验器：合法/非法样本各 ≥50 条参数化（种子公司扩展）
- [ ] 表达式引擎：白名单全部函数单测 + 步数上限 + 深嵌套 EvalBudgetError
- [ ] 迁移管线：每版本真实样本快照测试
- [ ] 双端执行器 CI 任务挂 contract-diff 档（SKIP 退出条件见 00 篇 §7——M1.5 前必须生效）

## 9. 边界与不做的事

- 不做性能维度的表达式基准测试（步数上限已是防护）——留待压测篇观察项；
- 不校验 JSON Schema 的语义等价性（只比结构生成物）——枚举专项已单独覆盖最大风险；
- 不做协议文档与代码的自动比对（评审稿承担文档期一致性，代码期以生成物为准）。

## 10. 与既有文档的关系

| 主题 | 真源 | 本篇角色 |
|---|---|---|
| 协议类型定义 | 前端 01FE §2-3 | 测试矩阵消费方 |
| 表达式向量 | 前端 01FE §4 | 执行器契约与覆盖矩阵细化 |
| 枚举专项比对 | 评审稿 §7 行动项 #1 | 测试设计定版（本篇 §4），M1.5 落地 |
| 错误码表 | 后端 10BE §A.3 | 契约测试对象（§7） |
| aggregate 修复回归 | 评审稿 §7 #2 | C-STRUCT-09 回归用例 |
| FlowSchema 定义 | 前端 10FE §2.1 | C-STRUCT-10 用例 |
