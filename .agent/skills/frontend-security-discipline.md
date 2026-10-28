---
name: frontend-security-discipline
description: 前端安全纪律——XSS 三防线、token 不落地、CSP 三态、脚本消息桥白名单
triggers:
  - innerHTML
  - 富文本
  - XSS
  - CSP
  - iframe 嵌入
  - 脚本上传
  - window.open
version: 1
updated: 2026-10-28
---

# 前端安全纪律

## 何时使用

渲染用户/租户可控内容（富文本、字段值、文件预览）、配置 CSP、实现脚本相关功能、嵌入/被嵌入场景时。攻防六类验收见 PRD 10 §5。

## 规则/经验

1. **XSS 三防线**（安全体系定版）：富文本存储 tiptap JSON（不存 HTML）→ 渲染侧 DOMPurify 清洗 → 输出侧 React 转义。**禁 `dangerouslySetInnerHTML`**（按既定安全策略执行，不自行给富文本或 Canvas 增加白名单；确需 HTML 注入必须先评审安全边界与清洗策略）。
2. **用户数据永不信任**：字段值进页面一律走 React 组件 props（自动转义）；动态类名/样式先过白名单映射；URL 跳转校验协议（禁 `javascript:` 注入，`URL` 解析后检查 origin/协议）。
3. **脚本红线三道闸**（08FE §3）：编译期红线扫描（`eval`/`new Function`/成员链拦截）→ Worker 消息桥 op 白名单 → 真实浏览器 CSP `connect-src 'none'` 兜底。业务代码不得绕过 script-host 直接 `new Worker`。
4. **CSP 三态独立**（设计器/运行时/产物域）：由网关/后端响应头统一下发（非 meta），前端职责是**不写违反 CSP 的代码**（无内联事件、无内联 script、样式走文件）；Worker 脚本响应头独立策略。
5. **嵌入边界**：被嵌入走 iframe sandbox 受控属性 + `frame-ancestors` 白名单；主动嵌入外部内容（连接器预览等）必须独立源 + sandbox 最小权限。
6. **敏感数据清单不入前端持久层**：token（SDK 内存/指定存储管理）、密码、上传文件原文——禁 localStorage 存敏感项、禁 URL query 带 token、禁错误上报携带响应体全文（只报 traceId + 错误码）。
7. **依赖安全**：新依赖查 CVE；锁文件变更与功能 PR 分离（供应链攻击面）。

## 反模式（踩过的坑）

- 用 `innerHTML` 渲染「内部生成」的 HTML → 生成链路一旦掺入用户字段即存储型 XSS；一律 JSX。
- iframe 嵌运行时页带完整凭证 → 被嵌方拿到宿主权限；嵌入走独立预览凭证交换（06FE §6）。
- 文件预览直接 `window.open(url)` → svg/html 独立内容域必须强制 `attachment`（11BE 定版），前端跳转用服务端签发的预览 URL。
- 上传文件名原样入库再渲染 → 文件名也是用户输入；展示前转义。

## 验证方式

攻防用例 A1/A2/A3（02 篇测试文档 §5）执行通过；lint 无 `dangerouslySetInnerHTML`；CSP Report-Only 期误报清零后才转强制（G2 前置条件）。
