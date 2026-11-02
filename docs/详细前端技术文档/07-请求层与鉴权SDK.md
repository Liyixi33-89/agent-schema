# 详细前端技术文档 07 · 请求层与鉴权 SDK（request-sdk / auth-sdk）

> 上游：《技术方案-前端(React).md》v0.3 §1/§5；后端技术方案 §5（统一 CRUD 协议）、§4（租户上下文）
> 本文定位：**实现级技术设计**——OpenAPI 类型生成、通用数据 hooks、错误码体系、登录态与权限缓存
> 包：`packages/request-sdk`、`packages/auth-sdk`（设计器与运行时共用）

---

## 1. 职责边界

| request-sdk | auth-sdk |
|---|---|
| fetch 封装（拦截器链：租户/鉴权/trace/重试） | 登录/登出/会话刷新（Cookie 滚动签发）/一次性 code |
| OpenAPI 生成的类型化 client（禁止手写 DTO） | 用户信息与权限快照缓存 |
| 通用数据 hooks（useModelList/Detail 等，React Query） | 权限判断 API（hasPerm/hasRole） |
| 统一错误归一化（业务码→异常类） | 多标签页登录态同步（BroadcastChannel，§5） |
| 计量请求走独立通道（不计入业务网关限流） | 不负责权限数据的服务端判定 |

## 2. request-sdk 分层

```
Layer 1  httpFetch：超时（默认 10s）/ 中断（AbortController）/ 网络错误重试（幂等方法 2 次）
Layer 2  拦截器链（有序）：
           tenant → 注入 X-Tenant-Id（运行时容器解析，§06）
           auth   → Cookie 会话通道（v0.4 定版）：credentials:'include' 同源/白名单域自动携带
                     schema_at/schema_rt；注入 X-CSRF-Token（读 schema_csrf cookie，双提交）；
                     401 触发静默刷新重放（单飞：并发 401 只发一次刷新——POST /api/auth/refresh 无需 body，
                     refresh cookie 由浏览器自动携带）；预览/嵌入态例外：内存 Bearer 短时凭证照旧注入
                     Authorization 头（预览会话无刷新，401 即失效）
           trace  → 注入 X-Trace-Id（透传后端链路）
           meter  → usage-tracker 独立 endpoint 直连（HMAC 轻签名，不经业务拦截器）
Layer 3  apiClient：OpenAPI 生成（openapi-typescript + openapi-fetch）
           类型来自后端动态 OpenAPI JSON → api-types.gen.ts（CI 生成，PR 自动更新）
Layer 4  hooks：React Query 封装
```

## 3. 通用数据 hooks（与后端统一协议对齐）

```ts
// 后端：GET /api/data/{modelId}?filter=&sort=&page=&size=，响应 {list,total,page,size}
function useModelList(modelId: string, query: { filter?: FilterNode; sort?: SortSpec;
                   page?: number; size?: number }) {
  return useQuery({
    queryKey: ['model', modelId, query],          # 结构化 key：filter 变化自动重新请求
    queryFn: () => apiClient.GET('/api/data/{modelId}', { params: { query: encodeQuery(query) } }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,            # 翻页不闪白屏
  });
}

useModelDetail(modelId, id)     # 详情
useModelAggregate(modelId, agg) # 仪表盘聚合（P2）
useSaveModel(modelId)           # create/update 合一 mutation（按 id 有无分派）
```

- `encodeQuery`：FilterNode 树序列化为后端约定 JSON（压缩为 query 参数 base64 或 body——以后端 §5 定义为准，双端契约测试锁定）；
- size 硬限 200：hook 层 clamp（`Math.min(size, 200)`），超限自动截断并开发告警；
- mutation 成功后失效 `['model', modelId]` 相关 queryKey（含列表/详情/聚合）。

## 4. 错误归一化（统一异常类）

```
ApiError {
  httpStatus: number;
  bizCode: string;          # 后端统一错误码体系（BIZ_xxx / QUOTA_EXCEEDED / CONFLICT ...）
  message: string;          # 用户可读文案（后端下发或前端码表映射）
  traceId: string;
  retryable: boolean;       # 幂等冲突/网络错误=true；权限/校验=false
}

409 场景特殊化：VersionConflictError（携带 serverVersion）→ 设计器三方对比流程（§04 §7）
QUOTA_EXCEEDED 场景：结构化升级引导 payload（后端 §09）→ 前端统一弹层组件消费
PASSWORD_CHANGE_REQUIRED（403）：全局拦截重定向强制改密页（§5）——唯一不上抛业务层的错误码
```

## 5. auth-sdk（v0.4 定版：HttpOnly Cookie 会话通道，2026-11-02）

```
凭证存储（正式登录态）：HttpOnly Cookie 三件套——前端零凭证存储：
  schema_at    access 2h：HttpOnly + Secure + SameSite=Lax + Path=/
               （JS 不可读——XSS 无法窃取凭证本体离线重放）
  schema_rt    refresh 7d：HttpOnly + Secure + SameSite=Strict + Path=/api/auth
               （Path 收窄：业务请求不携带，缩小暴露面。⚠️ 边界：Path 不阻止同源脚本
                向 /api/auth/refresh 发请求——XSS 场景该请求仍携带 cookie；refresh 面
                真实防线 = 一次性消费 + 黑名单 + 双提交，Path 只是纵深一层）
  schema_csrf  CSRF 双提交源：可读（非 HttpOnly）+ Secure + SameSite=Lax + Path=/
               （随机数，登录/刷新/改密响应滚动更新；请求头 X-CSRF-Token 与之等值校验）
  Set-Cookie 均由后端签发（03BE §4.1）；登出 = 后端清 cookie + refresh 黑名单写入
  ⚠️ 权衡说明（相对旧方案的取舍）：HttpOnly 使 XSS 无法窃取凭证本体，但 XSS 仍可借当前会话
     发起请求（请求伪造）——防线转移至 CSP（阻断脚本注入源头）+ 双提交（跨站请求伪造拦截），
     不再依赖「token 不在 storage」这一单点。sessionStorage 镜像与内存 token 全部废除
  过渡兼容：request-sdk 保留 Bearer 注入分支（后端双通道识别），存量集成与 SDK 老版本
     调用方在迁移窗口内不破坏；新代码一律走 Cookie 通道
CSRF 初始化：登录页加载即调 GET /api/auth/csrf 取匿名 csrf（登录请求带头等值校验，
     防登录 CSRF）；登录/刷新/改密响应滚动更新会话绑定的 csrf——SDK 读 document.cookie
     中 schema_csrf 注入头，不额外存储
刷新：access 有效期 2h，过期前 5min 静默刷新（单飞锁）；刷新请求自动携带 schema_rt
     （Path=/api/auth）→ 响应滚动签发新三件套（Set-Cookie）——SDK 无需读取/存储任何 token
统一认证请求（2026-11-02 收口）：auth-sdk 提供 authFetch() 作为三应用（designer/admin-console/
     runtime 正式通道）唯一请求入口——自动注入双提交头；401 先静默刷新一次再重放原请求
     （刷新失败触发 onSessionExpired 回调清本地态跳登录）；403 CSRF_TOKEN_REJECTED 自动拉新
     csrf 重试一次（多标签并发刷新致旧 csrf 滚动场景）；预览 Bearer 通道不经过 authFetch
     （credentials:'omit' 隔离不变）
多标签并发刷新协调（2026-11-02 补）：BroadcastChannel('auth') 扩展 {type:'refreshed'}
     广播——A 标签刷新成功后广播，B 标签收到即放弃本地排队刷新直接重放原请求；
     新 schema_csrf 一并经广播同步（防 B 标签持旧值被误拒 403）；BC 不可用降级为
     每标签页独立刷新（服务端 ±10s 重放容忍窗口兜底，不依赖跨标签协调）；
     降级路径下旧 csrf 请求 403 时 SDK 自动拉取新 csrf 重试一次（仅一次再上抛）
一次性 code（嵌入场景）：宿主传 code → POST 换预览态 Bearer 凭证（内存持有）→ 预览会话
     与正式 Cookie 会话并存互不污染（同一浏览器打开预览不影响已登录的设计器会话）
通道隔离强制（2026-11-02 补）：预览/嵌入请求一律 credentials:'omit'（不带任何平台
     cookie）；预览 Bearer 401 失效后只展示占位页，禁止回落正式会话或触发正式刷新——
     request-sdk 的 Cookie 通道与预览 Bearer 通道为两个独立实例，不共享封装
权限快照：{ userId, roles, perms: Set<string>, dept } → hasPerm(perm) O(1)（凭证不可读不影响——
     快照来自 GET /api/me 响应体，非 token 解析）
失效：登出/401 刷新失败/切换租户 → 清快照 + 跳登录（cookie 由后端响应清除；前端额外
     主动 document.cookie 删 schema_csrf 残留——HttpOnly 两枚只能服务端清）
多标签页（2026-10-28 修正保留）：**BroadcastChannel('auth') 广播登出**（一端登出全端登出）
  Cookie 会话下语义不变：A 页登出 → 后端清 cookie → B 页下一请求 401 → 清快照跳登录；
  BroadcastChannel 让 B 页**即时**感知（不等下一次请求）。降级路径不变（BC 不可用轮询心跳戳）
首次登录强制改密（P1 成员生命周期，详细 PRD 04 §2.6；后端 03 §A.3.1）：
  建号/管理员重置后 must_change_password=true → 除放行名单（改密/登出/me）外全部请求 403
  PASSWORD_CHANGE_REQUIRED——SDK 全局拦截该错误码 → 重定向强制改密页
  （不弹 toast 不重试：改密前任何界面都不可用）
  改密成功恢复定版（2026-10-28 补；v0.4 通道适配）：改密接口响应以 Set-Cookie 签发新会话
  三件套（旧 schema_rt 即刻入黑名单）→ SDK 清旧快照拉新快照恢复完整登录态（不跳登录页）；
  广播 {type:'reauth'} 通知其他标签页——其他端旧会话下一请求 401 REFRESH_REVOKED → 同步失效
  （多设备踢出语义：改密者无感恢复，其他端强制下线）
  P1 无邮件通道：初始密码由管理员建号时设定/服务端生成一次性返回（线下交付）；
  邀请邮件与自助找回 P2 随邮件通道上线
```

## 6. 单元测试硬性要求

- [ ] 401 单飞：并发 3 个 401 请求只触发一次刷新且全部重放成功（Cookie 通道：刷新请求零 body，schema_rt 自动携带）
- [ ] CSRF 双提交：状态变更请求均注入 `X-CSRF-Token`（与 schema_csrf 等值）；登录前匿名 csrf 获取并注入（登录 CSRF 防护）；登录/刷新/改密后新 csrf 值即时生效（旧值请求 403 → 自动拉新值重试一次）
- [ ] 凭证不可达断言：`document.cookie` 不含 schema_at/schema_rt（HttpOnly 生效）；SDK 任何代码路径不读取/存储 access/refresh 本体
- [ ] 租户头/trace 头：拦截器对所有请求生效（含动态 URL）
- [ ] size clamp：超 200 自动截断；响应 total 透传正确
- [ ] 错误归一化：各 bizCode 映射正确异常类；409 携带 serverVersion
- [ ] 权限缓存：hasPerm 命中/未命中；登出后失效
- [ ] 多标签页登出广播生效（BroadcastChannel：A 标签页登出 → B 标签页清凭证跳登录；BC 不可用降级心跳戳轮询生效）
- [ ] 多标签并发刷新协调：A 标签刷新成功广播 {type:'refreshed'} → B 标签放弃排队刷新直接重放；BC 不可用时两端独立刷新均成功（服务端 ±10s 重放容忍兜底，无端被误踢）
- [ ] 通道隔离：预览请求 `credentials:'omit'` 不带 schema_at/schema_csrf；预览 401 不触发正式会话刷新不回落（直接占位页）；Cookie 通道与预览通道为独立实例
- [ ] **PASSWORD_CHANGE_REQUIRED**：未改密账号访问任意接口被重定向强制改密页（非 toast 非重试）；改密成功后 Set-Cookie 新会话生效、权限快照重拉、不跳登录页；其他标签页旧凭证触发 401 REFRESH_REVOKED 同步失效
- [ ] 预览态隔离：同一浏览器正式 Cookie 会话 + 预览 Bearer 态并存，互不污染（预览请求不带 schema_at；正式请求不带预览 Bearer）

---

## 附录 · 对接接口清单（消费方视角）

> request-sdk 是全平台 HTTP 收口；本清单仅列 SDK 直连的接口。业务数据接口（模型 CRUD/流程等）由 hooks 层按后端 02/05 附录封装，见各消费文档。

| # | 接口 | 用途 | 来源（后端文档） |
|---|---|---|---|
| 1 | `GET /api/open/v1/docs.json` | 类型生成：`openapi-typescript` → `api-types.gen.ts`（CI 自动，禁手写 DTO） | 06 §A.2 |
| 2 | `POST /api/auth/login` / `refresh` / `logout` / `exchange` | auth-sdk 登录态生命周期（§5：Set-Cookie 会话签发/滚动刷新/清除；静默刷新、单飞、黑名单失效跳登录）；`refresh` 请求零 body（schema_rt cookie 自动携带） | 03 §A.1 |
| 2a | `GET /api/auth/csrf` | 登录页加载匿名 csrf 签发（登录 CSRF 防护）；403 自动重拉场景复用（§5 CSRF 初始化） | 03 §A.1 |
| 3 | `GET /api/me` | 权限快照（hasPerm O(1)） | 03 §A.2 |
| 4 | `POST /api/metering/events` | 埋点独立通道（§2 Layer 4：不经业务拦截器，HMAC 轻签名，202 批量回执） | 09 §A.1 |
| 5 | 全部业务接口（通用约定消费方） | `X-Tenant-Id`/`X-Trace-Id` 注入、`{list,total,page,size}` 分页、错误体 `{code, message, traceId}` 归一化、409 版本字段、string ID | 10 §A.1/A.2 |

**对接约束**：

- `useModelList` 的 `encodeQuery`：前端 `FilterNode` → 后端 ConditionTree（操作符白名单 11 个，后端 02 §A.2）；契约测试锁定双端映射（文档 11 §5）；
- `QUOTA_EXCEEDED` payload `{upgradeUrl, metric, limit}` → 统一升级弹层组件（本层提供结构化事件，不散落各业务）；
- 409 归一化：`MODEL_VERSION_CONFLICT`→`VersionConflictError(serverVersion)`、`DRAFT_VERSION_CONFLICT`→`DraftConflictError(serverDraftVersion)`、`LOCK_HELD_BY_OTHER`→`LockHeldError(holder)`——消费方按异常类处理（文档 04FE/10FE）。
