---
name: shared-ui-reuse-discipline
description: 组件复用与共享纪律——先查再写、业务归属模块、跨模块才进 shared-ui
triggers:
  - 复用组件
  - shared-ui
  - 新建公共组件
  - 组件提取
version: 1
updated: 2026-10-28
---

# 组件复用与 shared-ui 收录纪律

## 何时使用

准备新建任何组件前、想把组件提取为公共组件时、或涉及 `packages/shared-ui` 的改动。

## 规则/经验

1. **写前先查三处**：`packages/shared-ui`（16FE §2 清单）→ 当前 app 内已有组件 → 物料库（若是画布场景）。命中即复用；「不知道有没有」不是跳过查找的理由——查目录是硬步骤。
2. **组件归属三去向判据**：仅本页面用 → 就地文件；本应用多页面复用 → app 内 `components/`；跨应用/跨包复用 → `shared-ui`。**禁止跳级**（页面组件直接进 shared-ui「以后会用」）。
3. **shared-ui 收录判据**（16FE §2-4）：面向跨应用稳定复用，引用方不足两应用时按文档告警而非自动拒收；提供组件文档与受控/非受控/错误态 story、交互测试。允许通过 request-sdk/auth-sdk 消费通用平台协议；TaskCenter、NotificationCenter 明确归属 shared-ui，业务导入导出触发页面留在对应应用。不得把特定业务页面或业务规则塞入共享包。
4. **依赖方向**：shared-ui 属 L3 共享底座，**禁依赖 L2 引擎包**（renderer/form-engine）；消费 propsSchema 的能力通过子组件注入而非反向依赖（dependency-cruiser 规则，00FE §7）。
5. **跨应用禁引页面代码**：designer/runtime/admin-console 互相 import 页面级代码 = 违规；共享逻辑下沉包、共享组件进 shared-ui（admin-console 与应用工作台共享后端契约但不共享页面代码，依赖图 M11.4 定版）。
6. **改造已有组件优于新建**：功能相近的新组件先评估扩展既有组件（新增可选 props 保持向后兼容），第二实现 = 未来维护分叉。

## 反模式（踩过的坑）

- 同一「成员选择器」在三个 app 各写一份 → 修复漏洞只改一处，其余两处带病上线；第三处出现时立即下沉。
- 把带 API 调用的业务组件放进 shared-ui → shared-ui 被迫依赖 request-sdk 消费方上下文，复用性归零。
- 复制组件改两行当新组件 → 漂移分叉；用组合/插槽（children/render props）吸收差异。

## 验证方式

新建组件 PR 自查清单：已查三处证明（PR 描述列出检索过的位置）；shared-ui 新增项对照三条判据；dependency-cruiser 无 shared-ui→L2 违规。
