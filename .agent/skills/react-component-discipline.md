---
name: react-component-discipline
description: React 业务组件实现纪律——组件化拆分、props/状态归属、逻辑分层，禁裸 DOM 与 HTML 拼装
triggers:
  - 新建组件
  - 组件拆分
  - useRef
  - dangerouslySetInnerHTML
  - innerHTML
version: 1
updated: 2026-10-28
---

# React 组件实现纪律

## 何时使用

新建页面/组件、拆分大组件、组件内出现 `useRef`/`useEffect` 操作 DOM、或任何 `schema-frontend/apps|packages` 下的 React 代码编写。

## 规则/经验

1. **只用 React + TypeScript 函数组件**（AGENTS.md §2 技术栈）：禁 class 组件；禁 `.jsx`（一律 `.tsx`）；类型来自 OpenAPI 生成或 zod 推导，禁手写 DTO。
2. **组件 = 视图 + 编排，业务规则不上组件**：领域规则走 schema-protocol（表达式/校验）；请求编排走 TanStack Query hooks；复杂交互逻辑抽自定义 hook（`useXxx`），组件体保持声明式。
3. **状态归属四问**再决定放哪：服务端数据 → TanStack Query；设计器全局 UI → Zustand；字段级表单/渲染态 → valtio 原子；组件内私有 → `useState`。跨组件私放 `useState` 提升是反模式信号。
4. **拆分触发线**：单文件 >300 行、单组件 props >10 个、一个 `useEffect` 干两件事、JSX 嵌套超 5 层——命中任一即拆（子组件/自定义 hook/配置常量三去向）。
5. **props 显式化**：定义 interface 并导出；事件回调 `onXxx` 命名；布尔 props 用有意义名（`disabled` 而非 `flag`）；透传容器组件用 `React.ComponentProps<typeof AntComp>` 继承而非 `any`。
6. **禁原生 DOM 操作与 HTML 字符串拼装业务页面**：不许 `document.querySelector/createElement/innerHTML` 操作业务 UI；焦点、尺寸、滚动等需求优先 AntD 受控能力，其次 `useRef` 绑定元素调浏览器 API（受控引用除外）；列表渲染用 JSX map 或组件列表，禁拼 HTML 字符串后插入。
7. **原生 API 合法场景**（不是禁 JavaScript）：Web Worker（script-host）、Canvas（设计器画布）、FileReader（导入）、剪贴板/通知等浏览器能力——通过 hook 封装暴露，组件内仍只写 JSX。
8. **列表 key 用稳定业务 id**，禁 `index`（重排丢状态）；条件渲染保持组件结构稳定，禁在同位置切换不同组件类型导致全量重挂载。

## 反模式（踩过的坑）

- 组件内 `document.getElementById('xxx')` 拿 AntD 内部元素改样式 → 样式失效且升级即崩；改用 AntD `classNames/styles` props 或 token（主题引擎 13FE §3）。
- `useEffect` 里 `setState` 互相追逐实现联动 → 状态来源不唯一；改为派生值（渲染期计算）或 valtio 订阅。
- 大页面单文件 800 行「以后再拆」 → 拆分成本随时间指数上升；超过触发线当场拆。
- `dangerouslySetInnerHTML` 渲染后端富文本 → XSS 入口；富文本走 tiptap JSON 渲染通道（安全体系定版）。

## 验证方式

`tsc --noEmit` 无错误；grep 断言：组件文件无 `document.`/`window.` 业务操作、无 `innerHTML`/`dangerouslySetInnerHTML`（白名单：rich-text 渲染器、Canvas 设计器内部）；ESLint react-hooks 规则全绿。
