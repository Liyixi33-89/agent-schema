---
name: ddd-aggregate-discipline
description: 后端聚合根纪律——不变式收口、事务边界、模块隔离的防绕过清单
triggers:
  - 聚合根
  - Service 层
  - 事务
  - 跨模块调用
  - *-api
  - 字段状态机
version: 1
updated: 2026-10-26
---

# 后端聚合根纪律

## 何时使用

写/改任何 `schema-platform/*` 的领域逻辑：Service 编排、实体修改、事务标注、跨模块调用。

## 规则/经验

1. **业务不变式只进聚合根**：改字段状态必经 `ModelAggregate.deleteField()` 之类领域方法；Service 层出现 `field.setStatus(DELETED)` 即违规（绕过状态机与影响面标记）。
2. **事务边界 = 单聚合**：一个 `@Transactional` 只改一个聚合；跨聚合一致用领域事件 + Outbox，不写跨聚合同步事务。
3. **模块间只见 `*-api`**：import 了别的模块 `domain|infrastructure` 包直接返工（ArchUnit 门禁兜底，但别等 CI 提醒）。
4. **查询走轻量 CQRS 但不绕权限**：QueryService 直查投影 DTO 允许不过聚合根，但必须走 data-module 权限注入管线——查询简化 ≠ 安全简化。
5. 领域层禁止 Spring/MyBatis 注解（工厂/配置类除外）；仓储接口定义在 domain，实现在 infrastructure。
6. DDL 铁律挂聚合根：永不 `DROP COLUMN`；删除字段=状态置 DELETED + 元数据停引用（后端文档 01 §3）。

## 反模式

- 贫血实体 + 千行 Service：规则散落十处互相打架，字段状态机形同虚设。(后端总纲 §7)
- 一个事务更新 Model + Page 两个聚合「省一次 MQ」：拆分当日变成分布式事务噩梦。(后端总纲 §7)
- QueryService 为性能绕过行级权限注入：越权入口，红线。(后端总纲 §5)

## 验证方式

ArchUnit 规则全绿（模块依赖/领域层纯净度）；不变式绕行用例（反射直改字段状态）断言失败即合规。
