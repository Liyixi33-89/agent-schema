---
name: java-service-implementation
description: Java 服务实现纪律——JDK21 无预览特性、分层职责归位、DTO 边界、依赖注入规范
triggers:
  - 新建 Service
  - Controller
  - DTO
  - 领域服务
  - @Autowired
version: 1
updated: 2026-10-28
---

# Java 服务实现纪律

## 何时使用

新建/修改 Controller、Application Service、领域服务、DTO，或任何 `schema-platform` 下的 Java 业务代码编写。真源：`docs/详细技术文档/00-后端架构总纲-DDD分层与战术设计.md`。

## 规则/经验

1. **语言与框架基线**：JDK 21（LTS）+ Spring Boot 3，**不启用预览特性**（03BE §2.1 定版：TenantContextHolder 接口化 + ThreadLocal 默认实现，预览特性不进主干）；构造器注入（IDE 生成 lombok `@RequiredArgsConstructor`），禁字段注入 `@Autowired`。
2. **四层职责铁律**：Controller 只做协议适配（参数绑定/DTO 转换/响应包装，**禁业务逻辑**）；Application Service 编排用例（事务边界/跨聚合事件/权限检查入口），**禁领域规则**；领域层承载不变式（聚合根方法校验状态机）；基础设施层实现接口。规则写错层 = 改层，不打补丁。
3. **DTO 三类不混用**：API DTO（契约层，字段变更走契约流程）/ 内部用例对象 / 领域对象（实体/值对象）。**Controller 禁直接返回数据库实体**（Jackson 序列化暴露内部结构 + 懒加载陷阱）；领域对象不出领域层边界。
4. **聚合纪律**（ddd-aggregate-discipline 联动）：业务不变式收口聚合根方法；跨聚合一致性走领域事件 + Outbox（AGENTS.md §7 后端 2）；Service 禁绕过聚合直接改聚合内字段。
5. **模块边界**：模块间只依赖对方 `*-api` 包（ArchUnit 门禁）；api 包只放接口与 DTO，禁把实现类塞进 api；跨模块调用走接口 + 事件，**禁跨模块表 join**。
6. **空值与返回**：查询未找到返回 `Optional<T>`（内部）/ 明确 404 响应（API 层）；**禁返回 null 集合**（返回空集合）；禁用 Optional 作字段/参数。
7. **工具纪律**：日期时间一律 `java.time`（禁 `Date`/`Calendar`）；字符串判空用 StringUtils；对象比较禁 `==`（包装类型陷阱）；Stream 只用于转换不过度嵌套（三层嵌套改 for）。

## 反模式（踩过的坑）

- Controller 里写 if 业务分支「一个接口搞定」 → 无法测试、无法复用；下沉 Application Service。
- 领域层 import Spring 注解（`@Service` 领域类） → 领域被框架绑架无法纯测；Spring 只在 App Service 与基础设施层。
- 用 Map<String,Object> 传业务数据 → 无类型契约、重构不报警；定义用例对象。
- @Transactional 标在 Controller/私有方法 → 事务不生效或边界失控；只标 App Service 公开方法（详见事务纪律 skill）。

## 验证方式

`tsc` 侧无涉；`mvn compile` 通过；ArchUnit 规则全绿（分层依赖/零 Spring 于领域层）；CR 对照四层职责表。
