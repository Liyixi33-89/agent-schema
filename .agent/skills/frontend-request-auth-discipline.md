---
name: frontend-request-auth-discipline
description: 前端请求与鉴权纪律——统一走 request-sdk/auth-sdk，禁裸 fetch，401/改密/凭证/登出全走既有机制
triggers:
  - fetch
  - axios
  - XMLHttpRequest
  - 401
  - token 刷新
  - 登出
  - 预览凭证
version: 1
updated: 2026-10-28
---

# 前端请求与鉴权纪律

## 何时使用

任何需要调用后端接口的场景，或代码中出现 `fetch`/`axios`/`XMLHttpRequest`/token 处理逻辑时。

## 规则/经验

1. **请求统一走 request-sdk**（07FE）：禁组件/hook 内裸 `fetch`、禁自装 axios 实例、禁 `XMLHttpRequest`。SDK 已内置：类型化 client（OpenAPI 生成）、错误归一化（错误码→UI 语义）、401 单飞刷新、traceId 透传。
2. **服务端数据一律 TanStack Query**：禁组件内 `useEffect + setState` 手拉数据；缓存 key 按资源命名空间；变更后 `invalidateQueries` 失效而非手动改缓存。
3. **鉴权流程不自造**：强制改密拦截（PASSWORD_CHANGE_REQUIRED → 仅放行改密/登出）、401 单飞（并发请求排队等刷新）、多标签登出同步（BroadcastChannel + storage 事件降级兜底，禁依赖 sessionStorage 标签隔离单打独斗）——全部是 SDK 既有机制，业务代码只消费 `/me` 状态。
4. **token 纪律**：存 SDK 指定位置；**永不出现在组件代码/日志/console/错误上报**；永不传进 Web Worker（消息桥代理 `api.call`，08FE §4.2）。
5. **预览凭证交换只走 runtime 容器通道**（06FE §6）：grant 单次有效 5min、previewSessionId 401 即时失效是服务端语义，前端不做本地「缓存跳过交换」的优化。
6. **错误处理三态**：业务错误（弹提示/内联校验）、系统错误（全局通知 + traceId 供工单）、网络错误（重试一次 + 降级文案）——按 07FE 错误归一化映射表分支，禁 `catch(e) {}` 吞错。
7. **上传走文件服务预签名直传**（11BE）：禁把文件 base64 塞 JSON 接口；大文件分块上传用既有通道。

## 反模式（踩过的坑）

- 组件里 `fetch('/api/xxx')` 绕开 SDK「少一层封装」 → 丢 401 刷新/traceId/错误归一化，跨租户排查断链。
- 刷新 token 竞态：三个请求同时 401 各自刷新 → 后刷新作废前者；单飞排队是唯一正确解。
- 把 token 存 localStorage 再传给 Worker 做请求 → 违反 L2 隔离红线（G7 一票否决项）。
- `console.log(error.response)` 调试遗留 → 响应可能含他人数据；用 traceId 上报。

## 验证方式

grep 断言：`packages|apps` 下无裸 `fetch(`/`axios`/`XMLHttpRequest`（白名单：request-sdk 实现、Worker 内 mock 网络层）；无 `console.log` 含 token/响应体；ESLint 规则禁未处理 Promise。
