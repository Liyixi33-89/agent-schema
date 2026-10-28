---
name: sql-injection-guard
description: 动态 SQL 防注入——占位符/白名单/固定条件顺序红线，任何拼 SQL 的地方适用
triggers:
  - SQL
  - QueryBuilder
  - DynamicQueryEngine
  - MyBatis
  - ConditionTree
  - 聚合查询
  - ORDER BY
  - LIKE
version: 1
updated: 2026-10-28
---

# 动态 SQL 防注入

## 何时使用

写/改任何涉及 SQL 构建的代码：DynamicQueryEngine、过滤条件树解析、聚合查询、MyBatis XML、排序/分页参数处理。

## 规则/经验

1. **值一律 PreparedStatement 占位符**，禁止字符串拼接值进 SQL（后端 02 §3.3 第 6 条）。
2. **标识符三来源白名单**：字段名/表名/操作符只来自服务端元数据与平台生成物——操作符固定 11 个（eq/ne/in/nin/like/between/gt/gte/lt/lte/isnull），不在白名单直接 400；表名 `biz_model_<modelId>` 中 modelId 必须来自服务端上下文且为数值，不接受用户输入拼进标识符位置。
3. **filter.field 校验 field_status='ACTIVE'**：DELETED 字段 400 且不给数据线索（后端 02 §3.3 第 2 步）。
4. **固定条件注入顺序不可变**：`tenant_id → deleted_at IS NULL → 行级权限`；聚合查询复用同一管线，不允许为性能跳段（后端 02 §3.6）。
5. **ORDER BY 同样过白名单**：排序字段来自元数据、方向只有 ASC/DESC 枚举，禁止把用户输入直接放 ORDER BY。
6. **LIKE 值转义** `%` `_` `\` 三个通配符；between 值数组长度必须为 2。
7. **所有读写必经 DynamicQueryEngine**，业务代码直连表（JdbcTemplate/裸 MyBatis 查询）禁止，CI 规约扫描兜底（后端 02 §5 铁律）。
8. 分页红线同构建器：LIMIT ≤200，`page*size > 100000` 返回 400 引导 cursor。

## 反模式

- `"WHERE name = '" + name + "'"` 一处出现整模块返工。
- ORDER BY 直接透传前端字符串「只是排个序」——注入 + 信息泄露双风险。
- 为绕权限管线在 Service 里写原生查询「先跑通再说」——直连表是 CI 扫描红线。(后端 02 §5)
- 聚合查询复制了一份不带权限注入的简化构建「统计不用那么严」——统计含权限外数据泄露口径。(后端 02 §3.6 口径一致性)

## 验证方式

单测覆盖：白名单外操作符 400、标识符注入样本被拒、LIKE 通配符转义、DELETED 字段 400；CI 规约扫描无直连表访问。
