# M11 应用基础服务 验收证据报告

> 状态：in_progress（2026-11-02 纠偏后）
> 上一轮「全部完成、独立审查通过」结论已被推翻：无真实浏览器验收、报告由实施会话自生成非独立审查。
> 本轮完成代码层全部安全缺口修复；浏览器验收与独立审查为剩余验收项。

## 一、2026-11-02 缺口修复清单（commit 382c7e4）

### 1. 应用级权限闸（堵同租户越权）
- `AppRoleService.requireAppAdmin(tenantId, appId, operatorId)`：本应用 `app_admin` 或持
  `org:manage` 的平台管理员（03BE §5 兜底）放行，其余 403 PERM_DENIED。
- 接入全链：detail / update / archive / restore / deletePrecheck / delete / saveNav /
  getNav(filtered=false) / addMember / updateMemberRoles / removeMember /
  HTTP GET members（Controller 层）。
- 卡片墙列表按成员可见性过滤（无角色不出卡片）。
- 验证：AppServiceIT.nonMemberSameTenantDeniedOnAllAppEndpoints（13 处断言）+
  AppHttpSecurityIT（真实过滤器链，详情/导航/成员读写全 403）。

### 2. 删除确认协议（precheck + confirmValue）
- `POST /api/apps/{id}/delete-precheck`：影响面（页面/发布/成员数）+ confirmField=name。
- `DELETE /api/apps/{id}` 携 `confirmValue`：完整应用名等值比对（与元数据域 TYPE_MODEL_NAME
  同构的高摩擦确认）；失败 409 APP_DELETE_CONFIRM_REQUIRED，无副作用。
- 成功路径记 PERM_CHANGE/APP_DELETE 审计（影响面入 diff）。
- 验证：AppServiceIT.deleteRequiresConfirmValueAndAudits + AppHttpSecurityIT.deleteRequiresConfirmValue。

### 3. 最后管理员并发锁
- `assertNotLastAdmin` 前置 `IamRepository.lockAppRow`（app 行 SELECT ... FOR UPDATE）：
  并发互相移除仅剩两管理员时串行化，恰一个成功、应用不孤儿。
- 验证：AppServiceIT.concurrentRemovalOfLastTwoAdminsLeavesOne（双线程 CountDownLatch 同步）。

### 4. 配额并发锁
- `AppService.create` 前置 `apps.lockQuotaAnchor(tenantId)`（锁最早 app 行）：
  同租户并发创建串行化「锁-计数-校验」，防竞态突破 50 上限。

### 5. 导航强化
- 节点 id 全树唯一（含嵌套，防路由歧义/渲染 key 冲突）。
- LINK url 仅允许 http(s)（`javascript:` 等注入向量拒绝——运行时直出 `<a href>`）。
- filtered=false（设计面全量树）须应用管理员；filtered=true 保持登录态（过滤即鉴权）。
- 验证：navNodeIdMustBeGloballyUnique / navLinkUrlSchemeRestricted。

### 6. 导航过滤默认放行修复（PageRefAdapter）
- 旧逻辑：以「当前用户是否持有 PAGE:view 行」推断「应用是否配置权限」→ 未授权用户被误判
  为未配置而放行全部页面。
- 新逻辑：`IamRepository.hasPagePermRows(tenantId, appId)`（任意角色的 PAGE:view 行，与当前
  用户无关）判定已配置 → 已配置则按用户持有集合精确过滤（未授权页面整枝剪除）；
  完全未配置则成员默认全可见（13BE §3.3）。

### 7. 管理端补齐
- `GET /api/org/members`（org:manage 闸）：admin-console 成员页消费契约落地。
- 公告发布 `POST /api/ops/notices` 补 `@Transactional`（单事务防半态）。

### 8. designer 工作台
- 导航页签新增节点：PAGE（引用本应用页面下拉）/ GROUP / LINK（http(s) 前置校验）三态弹层。
- 两段式删除弹窗：precheck 影响面展示 + 输入完整应用名才可确认。
- 归档/恢复后返回卡片墙刷新状态。

## 二、测试证据（WSL PostgreSQL 16，schema_dev）

- AppServiceIT：18/18 通过（13→18，新增同租户越权全链、删除确认+审计、并发互移、
  id 唯一、URL 安全校验、org:manage 兜底）
- AppHttpSecurityIT：4/4 通过（新建，真实过滤器链：HTTP 越权 403、删除确认 409、管理员正向通路）
- 全量 IT 门禁：**165 tests, 0 failures, 0 errors**（`mvn -pl bootstrap -am test -Dtest=*IT`）
- verify[commit]：doc-anti-corruption / frontend-tsc / backend-compile / contract-diff /
  frontend-build / frontend-test(121) / backend-test 七步绿；backend-it 步为 Windows 侧
  探活误报（127.0.0.1:5432 探不到 WSL PG，已登记），本体在 WSL 全绿。
- 前端 designer `tsc --noEmit` 零错误；三应用构建通过（前轮 verify 记录）。

## 三、剩余验收项（不实表述已纠正，待补）

1. **浏览器验收缺失**：工作台/运行时/管理端真实浏览器闭环（登录→卡片墙→设置四页签→
   导航新增→发布→运行时菜单过滤渲染）未执行。
2. **独立审查缺失**：review-M11.md 由实施会话自生成，非独立审查；修复后需独立复核。
3. 预览/正式缓存隔离、租户切换菜单重载、页面切换组件状态复用——运行时交互面待浏览器验证。
4. 台账状态已回退 in_progress，两项既有 acceptance 证据（591a893）仅代表当时构建与 IT 通过，
   不覆盖本轮安全修复（见 security-fix 项，commit 382c7e4）。
