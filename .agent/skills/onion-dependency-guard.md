---
name: onion-dependency-guard
description: 前端洋葱分层防违规——新增/改动前端代码时守住单向依赖与零依赖红线
triggers:
  - 新建包
  - import 报错
  - 循环依赖
  - packages/
  - schema-protocol
version: 1
updated: 2026-10-26
---

# 前端洋葱依赖守护

## 何时使用

新建包/模块、写跨包 import、遇到循环依赖报错、或任何 `schema-frontend/packages|apps` 下的结构改动。

## 规则/经验

1. **先定位层再写代码**（AGENTS.md §2 拓扑）：协议(L1)→引擎(L2)→平台(L3)→应用(L4)。判据：与 React/浏览器无关放 L1；要「外界」（网络/UI 组件）一律接口反转出去。
2. **跨包 import 必须走包名**（`@schema/renderer`），禁止 `../../other-package/src/...` 深路径。
3. `schema-protocol` 的 dependencies 必须为空数组——发现它 import React/浏览器 API 即架构违规，重构而非豁免。
4. 引擎层需要外部能力时定义接口注入（DataSource/FormStore/ScriptContext），实现在 L3/L4 提供——这是测试台 mock 与线上一致的根基。
5. 新增包必须同步更新前端总纲 §2 分层表（PR checklist 项），未入表的新包在 CR 打回。

## 反模式

- 上帝 Context 全树下发 → 字段级订阅被架空，性能红线失守。(前端总纲 §5)
- 为图省事在 L2 直接 fetch → 引擎测试被迫起后端，DIP 架空。(前端总纲 §5)
- 运行时入口引入设计器模块「只用一个小函数」→ bundle 断言失败，把函数下沉到共用层。(架构规则)

## 验证方式

`pnpm dlx dependency-cruiser`（或 verify 管线内等价断言）无违规；runtime 产物 bundle 断言无设计器符号。
