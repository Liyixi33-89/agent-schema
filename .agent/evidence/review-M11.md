# 独立审查：M11（2026-11-02）

- 审查对象：`.agent/evidence/M11-report.md` @ commit `5195282`
- 审查角色：independent-reviewer（与实施会话隔离）

## 审查结论：批准

## 审查过程

### 1. 复用优先原则核查（通过）

- 骨架期重复表已清除：`app_member`（与 V3 sys_role APP 型重复）、`app_release_ptr`
  （与 V4 app_release 重复）——V13 终稿仅 `app` + `ops_notice`，与已有发布机制无重叠。
- 成员授权走 IAM 席位守卫通道（`SeatGrantGuard` SPI 复用），未另建角色体系；
  设计能力席位判定口径（app_admin/developer）与 09BE 计量口径一致。

### 2. 安全面核查（通过）

- 跨租户隔离：所有仓储查询显式 `tenant_id` 谓词；IT 验证跨租户读返回 `APP_NOT_FOUND`
  （404 同判不存在，不泄露存在性）。
- 越权拦截：工作台卡片墙按 myRole 服务端过滤，无角色用户不可见；导航菜单
  `filtered=true` 服务端剪枝，前端不做二次判断。
- 最后管理员保护：移除唯一 app_admin 返回 409 APP_ADMIN_REQUIRED（防孤儿应用）。
- 预览凭证隔离保持：裸页面路由通道未变（#/page/:pageId）。

### 3. 并发与缓存核查（通过）

- 导航乐观并发：`nav_version` CAS + 领域层版本比对，过期提交 409 NAV_VERSION_CONFLICT
  有 IT 覆盖。
- Schema ETag/304：缓存命中走宿主缓存 schema 渲染；租户切换清全部页面级缓存
  （watchTenantChange）；304 时不覆写缓存（同 ETag 同内容协议保证）。

### 4. 测试证据核查（通过）

- AppServiceIT 13 用例真实 PG 执行全绿；全量门禁 112 用例（9 个既有 IT 类 + 新增）
  无回归。
- 前端 121 vitest + 三端构建通过。

### 5. 分期决策核查（合规）

- 导航编辑器列表式（非拖拽）、admin-console P2 范围（租户清单/档位/模板）、
  归档式删除——均已登记为分期决策，符合 13BE §6 与 PRD P1 范围划定。

## 遗留观察（不阻塞）

- `OpsController.requireOrgManage` 与 IAM 的权限判定逻辑同构但为独立实现——
  建议后续抽取到 iam-module 统一出口（当前两处口径一致，无功能差异）。
- 运行时菜单过滤的「未配置权限行默认全可见」口径已在报告 §6 显式声明——
  与 PagePermGate 注释同构，若后续要求默认拒绝需同步调整两处。
