# M11 应用基础服务 验收证据报告

> 状态：in_progress（2026-11-02 纠偏后）
> 上一轮「全部完成、独立审查通过」结论已被推翻：无真实浏览器验收、报告由实施会话自生成非独立审查。
> 本轮完成代码层全部安全缺口修复；浏览器验收与独立审查为剩余验收项。

## 〇、认证链第二轮收口（2026-11-02 晚，登录 Cookie 通道真实缺口修复）

上一轮「八项缺口已修复」复核后仍存在四处真实缺口，本轮全部闭合：

### P0 修复（阻断级）
1. **登录字段契约断裂**：designer/admin-console 提交 `account`，后端 `AuthController` 只读
   `username`——登录实际不可用。修复：auth-sdk `login()` 归一化（account→username 发送，
   协议字段定版 username，03BE §A.1）。
2. **Cookie+Bearer 混合请求绕过 CSRF**：旧逻辑任意「Bearer 」前缀头即豁免双提交——
   「受害 cookie + 伪造 Bearer 头」跨站请求可绕过。修复：Bearer 豁免仅在**无任何会话 cookie**
   时生效；混合请求回落双提交判定。
3. **refresh Cookie 未入会话判定**：`hasSession` 只判 schema_at——access 过期后带 rt 的请求
   落入匿名放行。修复：会话凭证判定 = AT **或** RT（双提交独立于 access 执行，03BE §4.1 ④）。
4. **登录保护非服务端强制**：无 csrf cookie 的登录请求直接匿名放行，绕过 Origin 校验。
   修复：登录端点无 csrf cookie 时强制 Origin 校验（跨站登录 CSRF 服务端边界；同源直登放行，
   登录失败计数兜底）。

### P1 修复（健壮性）
- 多标签 refreshed 广播消费：`silentRefresh` 前置消费他页成功信号直接返回，不再重复发刷新
  （服务端 ±10s 容忍窗口兜底语义保留）。
- runtime 入口注入 `onSessionExpired`（清页面缓存重载）；AppShell 导航请求由裸 fetch 改走
  统一 `client.get()`（authFetch：静默刷新 + 403 csrf 重试全覆盖）。
- 非法 Referer 按不匹配拒绝（try-catch），不再抛 500。

### 测试证据（新鲜执行，2026-11-02 晚）
- 新建 **CsrfHardeningIT 4 用例**（混合请求不豁免/纯 Bearer 仍豁免/RT+CSRF 双提交独立执行/
  登录跨站拒同源放行/非法 Referer 403 非 500）——4/4 通过。
- CookieSessionIT 9/9（旧「无 csrf 登录匿名放行」用例适配新语义补同源头）。
- IamSecurityChainIT 13/13（审计用例补同源 Origin——新语义下无 Origin 请求不达业务层属预期）。
- **全量 IT 门禁：176 tests, 0 failures, 0 errors, BUILD SUCCESS**（WSL PG 16，真实过滤器链）。
- 前端 auth-sdk 新增专项单测 **12 用例**（登录归一化/双提交注入/401 单飞刷新重放/
  刷新失败回调/403 自动重试/refreshed 广播消费）——12/12；前端全量 **133 passed (11 files)**。
- 四包构建通过（auth-sdk/runtime/designer/admin-console，turbo 9/9）。

### 已知边界（如实登记）
- 并发刷新容忍窗口内重放会各自滚动出新会话（服务端实现语义），与 03BE §4.1 文档「返回同一
  组新 cookie」表述存在口径差——实现侧各标签拿到可用三件套即达成「不误踢」目标；文档表述
  待下一轮协议文档修订时校准（不影响安全边界）。
- 登录失败计数（5 次锁 15 分钟）在 CsrfFilter 403 拦截时不消耗（未达业务层）——预期行为。

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
