---
name: api-contract-error-discipline
description: API 契约与错误纪律——DTO 对齐 OpenAPI、参数校验、统一响应结构、错误码分域登记
triggers:
  - 新增接口
  - 错误码
  - 参数校验
  - @Valid
  - 异常处理
  - 分页
version: 1
updated: 2026-10-28
---

# API 契约与错误纪律

## 何时使用

新增/修改任何 REST 接口、定义错误码、处理校验与异常时。真源：`docs/详细技术文档/10-基础设施与工程规范.md` §A（全局约定）。

## 规则/经验

1. **契约先行**：接口先对齐 OpenAPI 导出（前端 `api-types.gen.ts` 由其生成），再写实现——**禁实现完再补文档**、禁手改生成物。新增字段 = 契约变更：双端同步 + diff 通过（schema-contract-first 联动）。
2. **请求通用约定**（10BE §A.1）：分页 `{pageNo, pageSize}` + 排序白名单字段；过滤走 ConditionTree 协议（禁每个接口自造 filter 参数名）；幂等操作带 `Idempotency-Key` 头。
3. **响应通用约定**（10BE §A.2）：统一 `{code, message, traceId, details?}`；列表响应统一 `{items, total, pageNo, pageSize}`；**禁 HTTP 200 包业务失败**（code 业务码≠成功码时必须对应 4xx/5xx）；禁裸返回数组/裸字符串。
4. **参数校验三层**：DTO 注解校验（`@Valid` + jakarta.constraints）拦格式 → Service 前置校验拦业务前置条件（状态机不符等）→ 领域方法拦不变式。三层各司其职，禁全堆 Controller。
5. **错误码分域登记**（10BE §A.3）：新错误码必须登记分域表（枚举专项 CI 比对对象，01 篇测试文档 §7）；错误信息面向用户可读 + 不泄露内部细节（表名/SQL/堆栈）；**403 vs 404 语义**：跨租户资源一律 404 不泄露存在性（02 篇 TC-ISO-02）。
6. **异常处理收口**：全局 `@RestControllerAdvice` 统一转换（业务异常→错误码、校验异常→VALIDATION 子码、未知异常→500 + traceId）；业务异常用平台统一业务异常类携带错误码，**禁 `throw new RuntimeException("自定义中文")`**；禁 catch 后吞掉不打日志。
7. **向后兼容**：响应删字段/改语义 = 破坏性变更（C-API-03 拦截）；新增字段必须可选；枚举值只增不删（协议冻结流程）。

## 反模式（踩过的坑）

- 返回 `{success: true, data: null}` + 200 表达「没找到」 → 调用方无法区分不存在与空；用 404。
- 校验错误返回字段级信息拼在 message 里 → 前端无法内联定位；错误码 + details 结构化（前端 07FE 归一化依赖它）。
- 新错误码硬编码字符串绕过枚举 → 前端映射表失配（C-ERR-01 就是拦这个）；一律走登记枚举。
- e.printStackTrace() 或异常信息直接进响应 → 泄露内部结构给攻击者；全局兜底统一脱敏。

## 验证方式

OpenAPI diff 无未声明变更；错误码枚举专项比对（01 篇 C-ENUM-03）通过；每个登记错误码有触发用例（C-ERR-02——禁只测「返回 4xx」）。
