---
name: flyway-migration-discipline
description: Flyway 迁移规范——版本命名/已发布脚本不可改/幂等/DDL 铁律与锁表自检
triggers:
  - Flyway
  - 迁移脚本
  - ALTER TABLE
  - DDL
  - 新增表
  - 建索引
version: 1
updated: 2026-10-28
---

# Flyway 迁移规范

## 何时使用

新增/修改数据库结构：写 V 脚本、建表建索引、改列，以及评审他人迁移脚本。

## 规则/经验

1. **命名与目录**：`V<序号>__<模块>_<描述>.sql`，序号全局递增不回收；每模块独立 Flyway 脚本目录（后端 00 拆分前置检查、10 CI 硬性项）。
2. **两条线不混**：核心元表走 Flyway；用户动态业务表走元数据驱动 DDL 执行器（仅提升列，后端 10）。往 Flyway 里写业务表结构 = 越界。
3. **DDL 铁律**：永不 `DROP COLUMN`，字段只做逻辑删除（后端 01 §3）；迁移脚本中出现 DROP COLUMN 直接打回。
4. **已发布脚本不可修改**（Flyway checksum 校验，改了启动失败）；改结构 = 新增脚本。私有化客户靠此约定离线升级。
5. **CONCURRENTLY 不在事务内**：大表索引用 `CREATE INDEX CONCURRENTLY`（后端 02 §4），但 PostgreSQL 要求它跑在事务块外——Flyway 该脚本需配置非事务执行，否则迁移直接报错。
6. **幂等可重放**：`IF NOT EXISTS`/带 WHERE 的范围更新；避免依赖数据现状的裸 UPDATE。
7. **危险操作自检**：改列类型会重写全表（评估锁时长）；先加列后回填、批量 UPDATE 分批；PG11+ ADD COLUMN 带默认值是元数据级操作可放心用（后端 02 §4 选 STORED 同理）。

## 反模式

- 直接修改已应用的 V 脚本「就改一个字」——checksum mismatch，私有化环境启动失败。
- 在 Flyway 默认事务模板里写 CONCURRENTLY——迁移报错且可能留下 INVALID 索引。
- 迁移脚本里顺手 DROP COLUMN 清理「废弃字段」——违反平台铁律。(后端 01 §3)
- 一次性 UPDATE 千万行回填——锁表 + WAL 暴涨，分批才是正解。

## 验证方式

`mvn test` 启动即 Flyway migrate 成功；重复启动 checksum 校验通过；CONCURRENTLY 脚本在迁移日志中确认为非事务执行。
