# 详细前端技术文档 07 · 请求层与鉴权 SDK（request-sdk / auth-sdk）

> 上游：《技术方案-前端(React).md》v0.3 §1/§5；后端技术方案 §5（统一 CRUD 协议）、§4（租户上下文）
> 本文定位：**实现级技术设计**——OpenAPI 类型生成、通用数据 hooks、错误码体系、登录态与权限缓存
> 包：`packages/request-sdk`、`packages/auth-sdk`（设计器与运行时共用）

---

## 1. 职责边界

| request-sdk | auth-sdk |
|---|---|
| fetch 封装（拦截器链：租户/鉴权/trace/重试） | 登录/登出/token 刷新/一次性 code |
| OpenAPI 生成的类型化 client（禁止手写 DTO） | 用户信息与权限快照缓存 |
| 通用数据 hooks（useModelList/Detail 等，React Query） | 权限判断 API（hasPerm/hasRole） |
| 统一错误归一化（业务码→异常类） | 多标签页登录态同步（storage 事件） |
| 计量请求走独立通道（不计入业务网关限流） | 不负责权限数据的服务端判定 |

## 2. request-sdk 分层

```
Layer 1  httpFetch：超时（默认 10s）/ 中断（AbortController）/ 网络错误重试（幂等方法 2 次）
Layer 2  拦截器链（有序）：
           tenant → 注入 X-Tenant-Id（运行时容器解析，§06）
           auth   → 注入 Bearer token；401 触发刷新重放（单飞：并发 401 只发一次刷新）
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

## 5. auth-sdk

```
登录态存储：内存 token + sessionStorage 镜像（刷新恢复）；
  不落 localStorage（XSS 持久化风险面大，权衡：牺牲持久登录换安全）
  refreshToken 亦内存持有随请求体传输（非 Cookie）——当前形态 CSRF 面已收窄
  （Bearer Header 非自动携带），后端仍强制 Origin 校验兜底（后端 03 §4）
  P2 评估迁 HttpOnly Cookie：若引入，本 SDK 需加 CSRF Token 双提交逻辑（同步升级）
刷新：token 有效期 2h，过期前 5min 静默刷新（单飞锁）
一次性 code（嵌入场景）：宿主传 code → POST 换 token → 走标准登录态（code 60s 单次失效）
权限快照：{ userId, roles, perms: Set<string>, dept } → hasPerm(perm) O(1)
失效：登出/401 刷新失败/切换租户 → 清快照 + 跳登录
多标签页：storage 事件广播登出（一端登出全端登出）

首次登录强制改密（P1 成员生命周期，详细 PRD 04 §2.6；后端 03 §A.3.1）：
  建号/管理员重置后 must_change_password=true → 除改密接口外全部请求 403
  PASSWORD_CHANGE_REQUIRED——SDK 全局拦截该错误码 → 重定向强制改密页
  （不弹 toast 不重试：改密前任何界面都不可用）；改密成功后恢复正常登录态
  P1 无邮件通道：初始密码由管理员建号时设定/服务端生成一次性返回（线下交付）；
  邀请邮件与自助找回 P2 随邮件通道上线
```

## 6. 单元测试硬性要求

- [ ] 401 单飞：并发 3 个 401 请求只触发一次刷新且全部重放成功
- [ ] 租户头/trace 头：拦截器对所有请求生效（含动态 URL）
- [ ] size clamp：超 200 自动截断；响应 total 透传正确
- [ ] 错误归一化：各 bizCode 映射正确异常类；409 携带 serverVersion
- [ ] 权限缓存：hasPerm 命中/未命中；登出后失效
- [ ] 多标签页登出广播生效
- [ ] **PASSWORD_CHANGE_REQUIRED**：未改密账号访问任意接口被重定向强制改密页（非 toast 非重试）；改密成功后恢复

---

## 附录 · 对接接口清单（消费方视角）

> request-sdk 是全平台 HTTP 收口；本清单仅列 SDK 直连的接口。业务数据接口（模型 CRUD/流程等）由 hooks 层按后端 02/05 附录封装，见各消费文档。

| # | 接口 | 用途 | 来源（后端文档） |
|---|---|---|---|
| 1 | `GET /api/open/v1/docs.json` | 类型生成：`openapi-typescript` → `api-types.gen.ts`（CI 自动，禁手写 DTO） | 06 §A.2 |
| 2 | `POST /api/auth/login` / `refresh` / `logout` / `exchange` | auth-sdk 登录态生命周期（§5：静默刷新、单飞、黑名单失效跳登录） | 03 §A.1 |
| 3 | `GET /api/me` | 权限快照（hasPerm O(1)） | 03 §A.2 |
| 4 | `POST /api/metering/events` | 埋点独立通道（§2 Layer 4：不经业务拦截器，HMAC 轻签名，202 批量回执） | 09 §A.1 |
| 5 | 全部业务接口（通用约定消费方） | `X-Tenant-Id`/`X-Trace-Id` 注入、`{list,total,page,size}` 分页、错误体 `{code, message, traceId}` 归一化、409 版本字段、string ID | 10 §A.1/A.2 |

**对接约束**：

- `useModelList` 的 `encodeQuery`：前端 `FilterNode` → 后端 ConditionTree（操作符白名单 11 个，后端 02 §A.2）；契约测试锁定双端映射（文档 11 §5）；
- `QUOTA_EXCEEDED` payload `{upgradeUrl, metric, limit}` → 统一升级弹层组件（本层提供结构化事件，不散落各业务）；
- 409 归一化：`MODEL_VERSION_CONFLICT`→`VersionConflictError(serverVersion)`、`DRAFT_VERSION_CONFLICT`→`DraftConflictError(serverDraftVersion)`、`LOCK_HELD_BY_OTHER`→`LockHeldError(holder)`——消费方按异常类处理（文档 04FE/10FE）。
