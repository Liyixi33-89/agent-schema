---
name: tenant-isolation-guard
description: 多租户隔离红线——租户条件双保险、@TenantIgnore 纪律、伪造租户单测硬性项
triggers:
  - tenant_id
  - TenantContext
  - TenantIgnore
  - 跨租户
  - 新建表
  - 查询 Service
version: 1
updated: 2026-10-28
---

# 多租户隔离红线

## 何时使用

新建/修改含数据的表、写任何查询或写入 Service、处理定时任务与 MQ 消费、见到 @TenantIgnore。

## 规则/经验

1. **新表三件套**：`tenant_id BIGINT NOT NULL` + 以 tenant_id 为前缀的复合索引 + UNIQUE 约束带 tenant_id（如 `UNIQUE(tenant_id, app_id, model_key)`，后端 01/03 各表 DDL 均此模式）。
2. **双保险缺一不可**：MyBatis 拦截器兜底注入 + data-engine SQL 构建层显式注入（后端 03 §2.2）；新增查询路径时两层都要有用例。
3. **接口签名不出现 tenantId 参数**：网关解析 → header X-Tenant-Id → Filter 还原 TenantContext（存储实现接口化，后端 03 §2.1）；内部 RPC 隐式附件透传。Service 里需要租户一律 `TenantContext.get()`。
4. **@TenantIgnore 纪律**：仅限平台级管理查询；每处使用必须注释理由并在 CR 说明；出现在业务查询上即红线。
5. **CI 硬性项**：每个新增数据查询 Service 附带「伪造租户上下文被拦截」单测，无此用例不予合并（后端 03 §2.2）。
6. **异步/定时链路显式还原租户**：MQ 消费与定时任务从消息体/任务参数还原 TenantContext，禁止默认租户跑批写库。

## 反模式

- Service 方法传 tenantId 参数「更灵活」——绕开上下文，调用方漏传即串租户。(后端 03 §2.1)
- @TenantIgnore 加在业务查询上排查问题后忘了删——静默越权入口。
- JOIN/子查询场景只验证了主表拦截——拦截器对子查询表同样生效要有用例证明。(后端 03 §测试要求)
- 测试数据全用默认租户——拦截器从未被真实触发，上线即裸奔。

## 验证方式

伪造租户上下文单测全绿（含 JOIN/子查询/INSERT 样本，后端 03 §测试）；@TenantIgnore 使用处清单 CR 复核。
