---
spec_id: 003-iam-foundation
status: active
milestone: M3                # 依赖图 §3.4 权限基座（与 M1 后半并行）
created: 2026-10-29
last_verified_at: 2026-10-29
owner: 待定
---

# Spec · 权限基座（M3 · IAM）

## 1. 背景与目标

依赖图 §3.4：用户/角色/权限点 + JWT 认证 + RBAC 判定链 + 审计基座 + 成员生命周期（P1 无邮件通道口径）。前置：M3.1 租户上下文（M2 已交付 TenantContext 接口化 + Filter 还原，本 spec 补 JWT claim 绑定升级）。

## 2. 范围声明

**做**：

- V3 七表 DDL（Flyway）：sys_user/sys_role/sys_user_role/sys_role_permission/sys_role_data_scope/sys_dept/sys_refresh_token/sys_audit_log（03BE §3.1/§4/§6；审计表按月分区）
- 用户聚合：登录锁定状态机（5 次锁 15 分钟）+ 密码策略（≥8 位含字母数字）+ 强制改密标记（03BE §4/§A.3.1）
- JWT 手写 HS256（零新增运行时依赖：不引 jjwt——claim 只含 sub/tenant/typ/exp/jti，**不含权限明细**防权限变更后仍有效）
- 认证端点：登录（统一 401 防枚举）/ 刷新（滚动签发 + 旧 token 即刻吊销）/ 登出（03BE §A.1）
- `/api/me` 权限快照：roles + perms 串（`page:view:{id}` / `action:{key}` 形态，03BE §A.2——auth-sdk O(1) 判断真源）
- 成员生命周期 P1：建号（一次性初始密码只返回一次）/ 管理员重置（强制改密 + 全会话吊销）/ 本人改密（**改密响应内联签发新 token 对**——改密即换会话不强制重登录）+ 覆盖式授权（03BE §A.3.1/§A.3）
- JwtAuthFilter：Bearer 验签 + **JWT claim 与 X-Tenant-Id 绑定**（不一致 403 TENANT_MISMATCH + SECURITY 审计）+ 强制改密拦截（放行名单：改密/登出/me，其余 403 PASSWORD_CHANGE_REQUIRED）
- 审计基座：操作类（LOGIN/PERM_CHANGE）+ 安全类（SECURITY——锁定/枚举尝试/租户不一致）双事件流
- TenantContextFilter 升级：优先取 JWT claim（auth.* 属性），无 token 退化头值（M2 兼容期）

**不做**（随后续里程碑）：

- MyBatis 租户拦截器（当前 JDBC 显式谓词为主防线；拦截器随 M5 数据引擎统一 ORM 层引入）
- 行级/字段级数据权限 SQL 生成（M5.2 权限注入管线；本 spec 只落地 sys_role_data_scope 表与 scope 类型判定纯函数）
- 席位判定（M8.4；授权口径实现归 tenant-service）
- 组织部门树/批量导入（M11.4 应用基础服务一并交付；本 spec 只落 sys_dept 表）
- CSRF Origin 校验（网关层职责，M6 联调；本 spec 已确认 Bearer Header 面收窄）
- Redis 黑名单（本地无 Redis：refresh 吊销走库表 revoked 标记 + 哈希索引，语义等价；Redis 层随 M5）
- 权限变更广播推送（前端缓存失效推送随 M6 前端联调）

## 3. 接口契约

按 03BE §A 权威定义落地：`/api/auth/login|refresh|logout|reset-password`、`/api/me`、`/api/me/password`、`/api/org/members`、`/api/org/members/{userId}/roles`；错误码 UNAUTHORIZED(401)/REFRESH_REVOKED(401)/ACCOUNT_LOCKED(423)/TENANT_MISMATCH(403)/PASSWORD_CHANGE_REQUIRED(403)/PERM_DENIED(403)。

## 4. Tasks

- [x] T1 V3 七表 DDL（租户谓词齐备；审计按月分区 + DO 块幂等建分区）
- [x] T2 UserAccount 聚合（锁定状态机/密码策略/改密生命周期——纯领域零框架依赖）
- [x] T3 JwtCodec 手写 HS256（access 2h/refresh 7d；refresh 为随机串 + SHA-256 哈希落库）
- [x] T4 登录/刷新/登出 + me 快照 + 建号/重置/改密 + 覆盖式授权（AuthService）
- [x] T5 JwtAuthFilter（claim 绑定/强制改密拦截/TENANT_MISMATCH 审计）+ TenantContextFilter claim 升级
- [x] T6 审计基座（操作/安全双事件流；建号/重置/改密/授权/登录全采集）
- [x] T7 集成测试 9 用例全绿（03BE §7 硬性要求覆盖：锁定/滚动吊销/一次性密码/改密会话恢复/JWT 租户绑定/越权同文案）

## 5. Acceptance

- [x] A1 `verify -Level commit` 通过（backend-it 门禁含 IamServiceIT）
- [x] A2 失败 5 次锁 15 分钟；锁定后正确密码也拒绝（423）；不存在账号与错误密码同文案（防枚举）
- [x] A3 refresh 滚动签发；旧 token 重放 401 REFRESH_REVOKED；改密吊销全部旧会话（多设备踢出）
- [x] A4 一次性密码只返回一次（bcrypt 落库不落明文）；PASSWORD_CHANGE_REQUIRED 拦截按放行名单
- [x] A5 JWT claim 与 X-Tenant-Id 不一致 403 + SECURITY 审计；跨租户登录/授权/重置同判不存在
- [x] A6 改密响应内联新 token 对（不强制重登录）；me 快照 perms 串形态符合 03BE §A.2

## 6. 验证步骤

```text
1. docker compose up -d postgres
2. pwsh scripts/verify.ps1 -Level commit（backend-it 含 MetadataCommandServiceIT + IamServiceIT）
3. 集成测试直跑：mvn test "-Dtest=IamServiceIT"（Flyway V3 自动迁移）
```

## 7. 沉淀记录

- **登录失败计数事务坑（2026-10-29）**：login 主事务抛 BizException 回滚会把 `failed_attempts` 计数与 SECURITY 审计一起回滚——锁定永不触发。修复：失败计数拆 `REQUIRES_NEW` 独立事务（经 Spring 代理自注入调用，直接内部调用不生效）。教训：**「业务失败仍需持久化的副作用」必须独立事务**（计数/审计/限流标记同类）。
- **自注入代理（2026-10-29）**：同类内 `this.recordLoginFailure()` 绕过 Spring 代理 → `REQUIRES_NEW` 不生效。必须 `@Autowired @Lazy selfRef` 经代理调用。
- **密码策略异常类型（2026-10-29）**：领域层抛 IllegalArgumentException（策略断言），应用层必须包装为 BizException——否则测试 catch (BizException) 漏接且错误码不在契约表。教训：领域异常到接口层必须显式映射，不能依赖全局兜底。
- **JWT 手写边界（2026-10-29）**：手写 HS256（b64url + HMAC + 定形 claim 手工解析）可行——前提是 claim 结构完全自控（自身签发的固定形态）；若引入第三方 token 或 claim 可变结构必须换标准库。refresh 不用 JWT（随机串 + 库表哈希）——吊销语义需要服务端状态，无状态 JWT 反而复杂化黑名单。
- **审计分区表主键（2026-10-29）**：PG 分区表要求分区键含于主键 → `PRIMARY KEY (id, created_at)`；初始分区用 DO 块 + `EXCEPTION WHEN duplicate_object` 幂等。
- **一次性密码生成策略自撞（2026-10-29，CI 实证）**：纯随机 12 位字母数字串有 ~6% 概率全字母（无数字）——被自家密码策略拒绝，本地全绿 CI 撞上。修复：生成器结构化保证首位字母+第二位数字。教训：**带策略校验的生成器必须结构性满足策略**，概率性满足在 CI 重复跑下必然翻车；「本地绿 ≠ 远端绿」的又一实证（随机性差异）。
